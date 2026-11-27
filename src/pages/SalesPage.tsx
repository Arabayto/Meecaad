import { useState } from 'react';
import { Printer, Receipt, RotateCcw, XCircle } from 'lucide-react';
import { get, money, num, post } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { SaleReceipt } from '../components/Receipt';
import { DateRange, ErrorBox, Field, Money, PageHeader, ReasonModal, Stat, addDays, fmtTime, useFilters, useLoad, useSubmit } from '../components/ui';

/**
 * Sales history. On its own page, or `embedded` under the store's point of sale
 * (starting with today; `refreshKey` changes after each new sale).
 */
export function SalesPage({ embedded = false, refreshKey = 0 }: { embedded?: boolean; refreshKey?: number }) {
  const { business, businessName, today, can } = useAuth();
  const [from, setFrom] = useState(embedded ? today : addDays(today, -6));
  const [to, setTo] = useState(today);
  const [q, setQ] = useState('');
  const sales = useLoad(() => get('/sales', { business, from, to, q }), [business, from, to, q, refreshKey]);
  const [open, setOpen] = useState<any>(null);
  const [voiding, setVoiding] = useState(false);
  const [returning, setReturning] = useState(false);

  const show = async (id: string) => setOpen(await get(`/sales/${id}`));
  const filter = useFilters<any>(sales.data ?? [], [
    { key: 'by', label: 'Sold by', get: (s) => s.created_by_name },
    { key: 'status', label: 'Status', get: (s) => (s.status === 'voided' ? 'Cancelled' : s.returned_amount > 0 ? 'Part returned' : 'Completed') },
    { key: 'pay', label: 'Payment', get: (s) => (s.credit_amount && !s.payments_text ? 'On credit' : s.credit_amount ? 'Part credit' : s.payments_text?.includes(',') ? 'Split' : s.payments_text?.split(' ')[0]) },
    { key: 'cust', label: 'Customer', get: (s) => s.customer_name ?? 'Walk-in' },
  ]);
  const rows = filter.shown;
  const completed = rows.filter((s: any) => s.status === 'completed');
  const totals = {
    count: completed.length,
    sales: completed.reduce((s: number, r: any) => s + r.total - r.returned_amount, 0),
    credit: completed.reduce((s: number, r: any) => s + r.credit_amount, 0),
  };

  // Sales tracking (store only, for those who see reports): profit of each sale and of the period shown.
  const tracking = business === 'store' && can('reports');
  const profit = completed.reduce((s: number, r: any) => s + (r.profit ?? 0), 0);
  const summary = `${totals.count} sales · ${money(totals.sales)} after returns · ${money(totals.credit)} given on credit${tracking ? ` · ${money(profit)} profit` : ''}`;
  return (
    <div className={embedded ? 'form-stack' : 'module-page'}>
      {!embedded && <PageHeader icon={<Receipt size={22} />} title={`Sales history — ${businessName(business)}`} subtitle={summary} />}
      <div className="panel">
        {embedded && <div className="panel__header"><div><p>{summary}</p><h2>Sales history</h2></div></div>}
        <div className="row row--between" style={{ marginBottom: 12 }}>
          <DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
          <input className="form-input" style={{ maxWidth: 260 }} placeholder="Search receipt #, item, customer" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ErrorBox error={sales.error} />
        {tracking && (
          <div className="kpi-grid" style={{ marginBottom: 12 }}>
            <Stat label="Sales" value={money(totals.sales)} sub={`${totals.count} sales${totals.count ? ` · average ${money(Math.round(totals.sales / totals.count))}` : ''}`} />
            <Stat label="Profit on these sales" value={money(profit)} tone={profit < 0 ? 'red' : undefined} sub={totals.sales ? `margin ${Math.round((profit / totals.sales) * 1000) / 10}% · before expenses` : 'before expenses'} />
            <Stat label="Paid now" value={money(completed.reduce((s: number, r: any) => s + r.paid_amount, 0))} sub={`${money(totals.credit)} on credit`} />
            <Stat label="Returned / cancelled" value={money(completed.reduce((s: number, r: any) => s + r.returned_amount, 0) + rows.filter((r: any) => r.status === 'voided').reduce((s: number, r: any) => s + r.total, 0))}
              sub={`${rows.filter((r: any) => r.status === 'voided').length} cancelled · ${completed.filter((r: any) => r.returned_amount > 0).length} with returns`} />
          </div>
        )}
        {filter.bar}
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Time</th><th>Customer</th><th className="num">Total</th><th>Paid with</th><th className="num">On credit</th>{tracking && <th className="num">Profit</th>}<th>Status</th><th>Sold by</th></tr></thead>
            <tbody>
              {rows.map((s: any) => (
                <tr key={s.id} className="tr--clickable" onClick={() => show(s.id)}>
                  <td><strong>{s.number}</strong></td>
                  <td className="small">{fmtTime(s.created_at)}</td>
                  <td>{s.customer_name ?? <span className="muted">Walk-in</span>}</td>
                  <td className="num"><Money c={s.total} />{s.returned_amount > 0 && <div className="small muted">−{money(s.returned_amount)} returned</div>}</td>
                  <td className="small">{s.payments_text ?? '—'}</td>
                  <td className="num">{s.credit_amount ? money(s.credit_amount) : '—'}</td>
                  {tracking && <td className="num">{s.status === 'completed' ? <span style={{ color: s.profit < 0 ? '#b91c1c' : '#15803d' }}>{money(s.profit)}</span> : '—'}</td>}
                  <td>{s.status === 'voided' ? <StatusBadge label="Cancelled" tone="red" /> : s.returned_amount > 0 ? <StatusBadge label="Part returned" tone="yellow" /> : <StatusBadge label="Completed" tone="green" />}</td>
                  <td className="small"><strong>{s.created_by_name}</strong></td>
                </tr>
              ))}
              {!sales.loading && !rows.length && <tr><td colSpan={tracking ? 9 : 8} className="muted">No sales in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title={open ? `Sale #${open.number}` : ''} width="md"
        footer={open && <>
          {can('void') && open.status === 'completed' && open.returned_amount < open.total && (
            <button type="button" className="btn btn-secondary" onClick={() => setReturning(true)}><RotateCcw size={16} /> Return items</button>
          )}
          {can('void') && open.status === 'completed' && open.returned_amount === 0 && (
            <button type="button" className="btn btn-danger" onClick={() => setVoiding(true)}><XCircle size={16} /> Cancel sale</button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print</button>
        </>}>
        {open && <SaleReceipt sale={open} />}
        {open?.status === 'voided' && <p className="small muted no-print">Cancelled by {open.voided_by_name} on {fmtTime(open.voided_at)}</p>}
      </Modal>

      {open && (
        <ReasonModal open={voiding} onClose={() => setVoiding(false)} title={`Cancel sale #${open.number}?`} action={`/sales/${open.id}/void`} confirmLabel="Cancel sale"
          message={<>The money ({money(open.total)}) is reversed{open.credit_amount ? ' and the customer debt removed' : ''}, and stock goes back. The sale stays in history marked as cancelled.</>}
          onDone={() => { setOpen(null); sales.reload(); }} />
      )}
      {open && returning && <ReturnModal sale={open} onClose={() => setReturning(false)} onDone={() => { setReturning(false); show(open.id); sales.reload(); }} />}
    </div>
  );
}

export function ReturnModal({ sale, onClose, onDone }: { sale: any; onClose: () => void; onDone: () => void }) {
  const { activeMethods } = useAuth();
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [method, setMethod] = useState(sale.payments[0]?.method_id ?? (sale.customer_id ? '' : 'cash'));
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState('');
  const { run, busy } = useSubmit();
  const factor = sale.subtotal ? sale.total / sale.subtotal : 0;
  const estimate = sale.items.reduce((s: number, i: any) => s + Math.round(i.line_total * factor * ((Number(qtys[i.id]) || 0) / i.qty)), 0);

  const submit = async () => {
    const r = await run((key) => post(`/sales/${sale.id}/return`, {
      items: Object.entries(qtys).filter(([, v]) => Number(v) > 0).map(([saleItem, v]) => ({ saleItem, qty: Number(v) })),
      refundMethod: method || null, restock, reason,
    }, key), 'Return saved');
    if (r) onDone();
  };

  return (
    <Modal open onClose={onClose} title={`Return items — sale #${sale.number}`} width="md"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Back</button>
        <button type="button" className="btn btn-primary" disabled={busy || !estimate || !reason.trim()} onClick={submit}>Refund {money(estimate)}</button></>}>
      <div className="form-stack">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th className="num">Sold</th><th className="num">Can return</th><th>Return qty</th></tr></thead>
            <tbody>
              {sale.items.map((i: any) => {
                const left = Number((i.qty - i.returned_qty).toFixed(3));
                return (
                  <tr key={i.id}>
                    <td>{i.name}</td><td className="num">{num(i.qty)}</td><td className="num">{num(left)}</td>
                    <td><input className="form-input" style={{ width: 90 }} inputMode="decimal" disabled={left <= 0} value={qtys[i.id] ?? ''}
                      onChange={(e) => setQtys({ ...qtys, [i.id]: e.target.value })} placeholder="0" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Field label="Give the money back by">
          <select className="form-select" value={method} onChange={(e) => setMethod(e.target.value)}>
            {sale.customer_id && <option value="">Take it off {sale.customer_name}'s debt</option>}
            {activeMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <label className="row"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Put the items back in stock (uncheck if damaged)</label>
        <Field label="Reason (required)"><input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
