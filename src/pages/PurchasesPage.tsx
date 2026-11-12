import { useState } from 'react';
import { Plus, Trash2, Truck } from 'lucide-react';
import { get, money, num, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../components/StatusBadge';
import { DateRange, ErrorBox, Field, Money, MoneyInput, PageHeader, PartySelect, ReasonModal, addDays, fmtTime, useFilters, useLoad, useSubmit } from '../components/ui';

interface Line { product: string; tank: string; qty: string; total: string }
const blank = (): Line => ({ product: '', tank: '', qty: '', total: '' });

export function PurchasesPage() {
  const { business, businessName, businesses, today, can, activeMethods } = useAuth();
  const isFuel = businesses.find((b) => b.id === business)?.kind === 'fuel';
  const products = useLoad(() => get('/products', { business }), [business]);
  const suppliers = useLoad(() => get('/suppliers', { business }), [business]);
  const tanks = useLoad(() => (isFuel ? get('/fuel/setup').then((r) => r.tanks) : Promise.resolve([])), [isFuel]);
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const list = useLoad(() => get('/purchases', { business, from, to }), [business, from, to]);
  const filter = useFilters<any>(list.data ?? [], [
    { key: 'by', label: 'Recorded by', get: (p) => p.created_by_name },
    { key: 'sup', label: 'Supplier', get: (p) => p.supplier_name ?? 'No supplier' },
    { key: 'status', label: 'Status', get: (p) => (p.status === 'voided' ? 'Cancelled' : p.total - p.paid_amount > 0 ? 'Owed' : 'Paid') },
  ], (p) => `${p.number} ${p.supplier_name ?? ''} ${p.items_text ?? ''} ${p.created_by_name}`, 'Search #, supplier, item');
  const [supplier, setSupplier] = useState('');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [date, setDate] = useState(today);
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [paid, setPaid] = useState('');
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  const [voiding, setVoiding] = useState<any>(null);
  const { run, busy } = useSubmit();

  const stocked = (products.data ?? []).filter((p: any) => p.track_stock && p.active);
  const total = lines.reduce((s, l) => s + toCents(l.total), 0);
  const paidC = toCents(paid);
  const owed = total - paidC;
  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const ready = lines.every((l) => l.product && Number(l.qty) > 0 && l.total !== '' && (!isFuel || l.tank)) && total >= 0 && paidC <= total && (owed === 0 || supplier);

  const save = async () => {
    const r = await run((key) => post('/purchases', {
      business, date, supplier: supplier || undefined, invoiceRef, note, paid: paidC, method: paidC > 0 ? method : undefined,
      items: lines.map((l) => ({ product: l.product, tank: l.tank || undefined, qty: Number(l.qty), total: toCents(l.total) })),
    }, key), isFuel ? 'Delivery saved' : 'Purchase saved');
    if (r) { setLines([blank()]); setPaid(''); setInvoiceRef(''); setNote(''); list.reload(); products.reload(); suppliers.reload(); }
  };

  return (
    <div className="module-page">
      <PageHeader icon={<Truck size={22} />} title={`${isFuel ? 'Fuel deliveries' : 'Purchases'} — ${businessName(business)}`}
        subtitle="Stock bought for selling. Rent, salaries and bills go in Expenses." />

      <div className="panel">
        <div className="panel__header"><div><p>New</p><h2>{isFuel ? 'Record a fuel delivery' : 'Record stock bought'}</h2></div></div>
        <div className="form-stack">
          <div className="form-row-3">
            <Field label="Supplier"><PartySelect kind="suppliers" value={supplier} onChange={setSupplier} items={suppliers.data ?? []} onCreated={suppliers.reload} /></Field>
            <Field label="Invoice / delivery note no."><input className="form-input" value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} /></Field>
            <Field label="Date"><input type="date" className="form-input" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
          <div className="table-wrap lines-table">
            <table>
              <thead><tr><th>Item</th>{isFuel && <th>Into tank</th>}<th>Quantity</th><th>Total cost</th><th className="num">Cost each</th><th></th></tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const p = stocked.find((x: any) => x.id === l.product);
                  return (
                    <tr key={i}>
                      <td><select className="form-select" value={l.product} onChange={(e) => setLine(i, { product: e.target.value, tank: '' })}>
                        <option value="">Choose…</option>
                        {stocked.map((x: any) => <option key={x.id} value={x.id}>{x.name} ({num(x.stock_qty)} {x.unit} now)</option>)}
                      </select></td>
                      {isFuel && <td><select className="form-select" value={l.tank} onChange={(e) => setLine(i, { tank: e.target.value })}>
                        <option value="">Choose…</option>
                        {(tanks.data ?? []).filter((t: any) => t.product_id === l.product && t.active).map((t: any) => <option key={t.id} value={t.id}>{t.name} ({num(t.stock_qty)} / {num(t.capacity)} L)</option>)}
                      </select></td>}
                      <td><input className="form-input" inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} placeholder={p?.unit ?? ''} /></td>
                      <td><MoneyInput value={l.total} onChange={(v) => setLine(i, { total: v })} /></td>
                      <td className="num small">{Number(l.qty) > 0 && l.total ? money(Math.round(toCents(l.total) / Number(l.qty))) : '—'}</td>
                      <td>{lines.length > 1 && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 size={14} /></button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setLines([...lines, blank()])}><Plus size={14} /> Add line</button></div>
          <div className="form-row-3">
            <Field label="Total"><div className="cart-total">{money(total)}</div></Field>
            <Field label="Paid now"><div className="pay-line">
              <MoneyInput value={paid} onChange={setPaid} />
              <select className="form-select" value={method} onChange={(e) => setMethod(e.target.value)}>{activeMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            </div>
              <div className="pay-actions" style={{ marginTop: 6 }}>
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => setPaid((total / 100).toFixed(2))}>Paid in full</button>
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => setPaid('')}>Nothing paid</button>
              </div>
            </Field>
            <Field label="Note"><input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          {owed > 0 && <div className={supplier ? 'mc-warn' : 'mc-error'}>{money(owed)} {supplier ? 'will be owed to the supplier.' : 'unpaid — choose the supplier it is owed to.'}</div>}
          {paidC > total && <div className="mc-error">Paid is more than the total.</div>}
          <div className="form-actions"><button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={save}>Save {isFuel ? 'delivery' : 'purchase'}</button></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel__header"><div><p>History</p><h2>{isFuel ? 'Deliveries' : 'Purchases'}</h2></div><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>
        <ErrorBox error={list.error} />
        {filter.bar}
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Date</th><th>Supplier</th><th>Items</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Owed</th><th>Status</th><th>Recorded by</th><th></th></tr></thead>
            <tbody>
              {filter.shown.map((p: any) => (
                <tr key={p.id}>
                  <td>{p.number}</td>
                  <td className="small">{p.entry_date}<div className="muted">{fmtTime(p.created_at)}</div></td>
                  <td>{p.supplier_name ?? '—'}{p.invoice_ref && <div className="small muted">Inv {p.invoice_ref}</div>}</td>
                  <td className="small">{p.items_text}</td>
                  <td className="num"><Money c={p.total} /></td>
                  <td className="num">{money(p.paid_amount)}{p.method_name && <div className="small muted">{p.method_name}</div>}</td>
                  <td className="num">{money(p.total - p.paid_amount)}</td>
                  <td>{p.status === 'voided' ? <StatusBadge label="Cancelled" tone="red" /> : <StatusBadge label="Received" tone="green" />}
                    {p.void_reason && <div className="small muted">{p.void_reason}</div>}</td>
                  <td className="small"><strong>{p.created_by_name}</strong></td>
                  <td>{can('void') && p.status === 'completed' && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setVoiding(p)}>Cancel</button>}</td>
                </tr>
              ))}
              {!list.loading && !filter.shown.length && <tr><td colSpan={10} className="muted">{filter.active ? 'Nothing matches.' : 'Nothing in this period.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {voiding && <ReasonModal open onClose={() => setVoiding(null)} title={`Cancel purchase #${voiding.number}?`} action={`/purchases/${voiding.id}/void`} confirmLabel="Cancel purchase"
        message={<>The stock ({voiding.items_text}) is removed and the money/debt ({money(voiding.total)}) reversed. Recorded {fmtTime(voiding.created_at)}.</>}
        onDone={() => { list.reload(); products.reload(); }} />}
    </div>
  );
}
