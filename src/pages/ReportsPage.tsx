import { Fragment, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, Printer } from 'lucide-react';
import { get, money, num } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { Tabs } from '../components/Tabs';
import { BizTag, DateRange, ErrorBox, Money, PageHeader, addDays, fmtTime, useLoad } from '../components/ui';

export const TYPE_LABEL: Record<string, string> = {
  sale: 'Sale', sale_void: 'Sale cancelled', sale_return: 'Return / refund', purchase: 'Purchase', purchase_void: 'Purchase cancelled',
  expense: 'Expense', expense_void: 'Expense cancelled', customer_payment: 'Debt collected', customer_payment_void: 'Debt collection cancelled',
  supplier_payment: 'Supplier paid', supplier_payment_void: 'Supplier payment cancelled', transfer: 'Transfer', transfer_void: 'Transfer cancelled',
  owner_in: 'Owner added money', owner_in_void: 'Owner money cancelled', owner_out: 'Owner took money', owner_out_void: 'Owner withdrawal cancelled',
  stock_usage: 'Kitchen usage', stock_waste: 'Waste / damage', stock_adjustment: 'Stock count correction', opening_stock: 'Opening stock',
  fuel_shift: 'Fuel shift sales', fuel_shift_void: 'Fuel shift cancelled', tank_dip: 'Tank dip variance', closing_diff: 'Daily closing difference', closing_reopen: 'Day reopened',
};
const ACCOUNT_LABEL: Record<string, string> = {
  cash: 'Money account', receivable: 'Customer debt', inventory: 'Stock', payable: 'Owed to supplier', sales: 'Sales', cogs: 'Cost of goods',
  expense: 'Expense', stock_loss: 'Stock loss', cash_diff: 'Cash difference', transfer: 'Between businesses', owner: 'Owner money',
};

export function ReportsPage() {
  const { businesses, businessName, today } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'pnl';
  const [scope, setScope] = useState('all');
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const summary = useLoad(() => (tab === 'ledger' ? Promise.resolve(null) : get('/reports/summary', { business: scope, from, to })), [scope, from, to, tab === 'ledger']);
  const s = summary.data;
  const cols = scope === 'all' ? [...businesses.map((b) => b.id), 'all'] : [scope];
  const colName = (c: string) => (c === 'all' ? 'All businesses' : businessName(c));

  return (
    <div className="module-page">
      <PageHeader icon={<BarChart3 size={22} />} title="Reports" subtitle="Calculated from every saved transaction"
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button>} />
      <div className="panel print-area">
        <div className="no-print">
          <Tabs activeTab={tab} onTabChange={(t) => setParams({ tab: t })} tabs={[
            { key: 'pnl', label: 'Profit & loss' }, { key: 'cash', label: 'Money in & out' }, { key: 'products', label: 'Best sellers' },
            { key: 'daily', label: 'Day by day' }, { key: 'ledger', label: 'All transactions' },
          ]} />
          <div className="row row--between" style={{ marginBottom: 14 }}>
            <div className="scope-tabs">
              <button type="button" className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All Businesses</button>
              {businesses.map((b) => <button key={b.id} type="button" className={scope === b.id ? 'active' : ''} onClick={() => setScope(b.id)}>{businessName(b.id)}</button>)}
            </div>
            {tab !== 'ledger' && <DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} />}
          </div>
        </div>
        <h3 className="print-only">Meecaad — {colName(scope)} — {from} to {to}</h3>
        <ErrorBox error={summary.error} />

        {tab === 'pnl' && s && (
          <div className="table-wrap">
            <table>
              <thead><tr><th></th>{cols.map((c) => <th key={c} className="num">{colName(c)}</th>)}</tr></thead>
              <tbody>
                <PnlRow label="Sales" cols={cols} get={(c) => s.profit[c].revenue} strong />
                <PnlRow label="− Cost of goods sold" cols={cols} get={(c) => -s.profit[c].cogs} />
                <PnlRow label="= Gross profit" cols={cols} get={(c) => s.profit[c].grossProfit} strong />
                <PnlRow label="− Expenses" cols={cols} get={(c) => -s.profit[c].expenses} />
                {[...new Set(s.expenses.map((e: any) => e.category))].map((cat: any) => (
                  <PnlRow key={cat} label={`      ${cat}`} cols={cols} muted
                    get={(c) => -s.expenses.filter((e: any) => e.category === cat && (c === 'all' || e.business_id === c)).reduce((t: number, e: any) => t + e.total, 0)} />
                ))}
                <PnlRow label="− Stock losses (waste, damage, fuel variance)" cols={cols} get={(c) => -s.profit[c].losses} />
                <PnlRow label="− Cash shortages (+ overages)" cols={cols} get={(c) => -s.profit[c].cashDiff} />
                <PnlRow label="= Net profit" cols={cols} get={(c) => s.profit[c].profit} strong />
                <tr><td colSpan={cols.length + 1} style={{ paddingTop: 18 }}><strong>Credit</strong></td></tr>
                <PnlRow label="Sold on credit in this period" cols={cols} muted get={(c) => s.credit.filter((r: any) => c === 'all' || r.business_id === c).reduce((t: number, r: any) => t + r.given, 0)} />
                <PnlRow label="Debts collected in this period" cols={cols} muted get={(c) => s.credit.filter((r: any) => c === 'all' || r.business_id === c).reduce((t: number, r: any) => t + r.collected, 0)} />
              </tbody>
            </table>
            <p className="small muted" style={{ marginTop: 10 }}>Profit counts a sale when it is made (also on credit) and the cost of the goods when they are sold or used — not when stock is bought. Transfers and owner money are not profit or expense.</p>
          </div>
        )}

        {tab === 'cash' && s && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Business</th><th>What</th><th className="num">Money in</th><th className="num">Money out</th><th className="num">Net</th></tr></thead>
              <tbody>
                {cols.filter((c) => c !== 'all').map((b) => {
                  const rows = s.cashFlow.filter((r: any) => r.business_id === b);
                  const tin = rows.reduce((t: number, r: any) => t + r.money_in, 0), tout = rows.reduce((t: number, r: any) => t + r.money_out, 0);
                  return (
                    <Fragment key={b}>
                      {rows.map((r: any) => (
                        <tr key={b + r.entry_type}><td><BizTag id={b} /></td><td>{TYPE_LABEL[r.entry_type] ?? r.entry_type}</td>
                          <td className="num">{r.money_in ? money(r.money_in) : ''}</td><td className="num">{r.money_out ? money(r.money_out) : ''}</td><td className="num"><Money c={r.money_in - r.money_out} signed /></td></tr>
                      ))}
                      <tr><td><BizTag id={b} /></td><td><strong>Total</strong></td><td className="num"><strong>{money(tin)}</strong></td><td className="num"><strong>{money(tout)}</strong></td><td className="num"><Money c={tin - tout} signed strong /></td></tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'products' && s && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Item</th><th>Business</th><th className="num">Quantity sold</th><th className="num">Sales</th><th className="num">Cost</th><th className="num">Gross profit</th></tr></thead>
              <tbody>
                {s.topProducts.map((p: any) => (
                  <tr key={p.product_id}><td>{p.name}</td><td><BizTag id={p.business_id} /></td><td className="num">{num(p.qty)}</td><td className="num">{money(p.revenue)}</td>
                    <td className="num">{p.cost ? money(p.cost) : <span className="muted">via ingredients</span>}</td><td className="num">{p.cost ? <Money c={p.revenue - p.cost} /> : '—'}</td></tr>
                ))}
                {s.fuel.map((f: any) => (
                  <tr key={f.name}><td>{f.name} (litres)</td><td><BizTag id="fuel" /></td><td className="num">{num(f.qty)}</td><td className="num">{money(f.revenue)}</td><td className="num">{money(f.cost)}</td><td className="num"><Money c={f.revenue - f.cost} /></td></tr>
                ))}
                {!s.topProducts.length && !s.fuel.length && <tr><td colSpan={6} className="muted">No sales in this period.</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'daily' && s && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th>{cols.map((c) => <th key={c} className="num" colSpan={1}>{colName(c)}<div className="small muted" style={{ textTransform: 'none' }}>sales / profit</div></th>)}</tr></thead>
              <tbody>
                {[...new Set(s.daily.map((d: any) => d.entry_date))].map((date: any) => (
                  <tr key={date}><td>{date}</td>{cols.map((c) => {
                    const rows = s.daily.filter((d: any) => d.entry_date === date && (c === 'all' || d.business_id === c));
                    return <td key={c} className="num">{money(rows.reduce((t: number, r: any) => t + r.revenue, 0))} / <Money c={rows.reduce((t: number, r: any) => t + r.profit, 0)} /></td>;
                  })}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'ledger' && <Ledger scope={scope} />}
      </div>
    </div>
  );
}

function PnlRow({ label, cols, get: value, strong, muted }: { label: string; cols: string[]; get: (c: string) => number; strong?: boolean; muted?: boolean }) {
  return (
    <tr>
      <td style={{ whiteSpace: 'pre', fontWeight: strong ? 700 : undefined, color: muted ? 'var(--text-muted)' : undefined }}>{label}</td>
      {cols.map((c) => <td key={c} className="num"><Money c={value(c)} strong={strong} /></td>)}
    </tr>
  );
}

function Ledger({ scope }: { scope: string }) {
  const { today } = useAuth();
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const list = useLoad(() => get('/reports/ledger', { business: scope, from, to, type, q }), [scope, from, to, type, q]);
  const [open, setOpen] = useState<any>(null);
  return (
    <>
      <div className="row no-print" style={{ marginBottom: 12 }}>
        <DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} />
        <select className="form-select" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <input className="form-input" style={{ maxWidth: 240 }} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorBox error={list.error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Business</th><th>Type</th><th>Details</th><th className="num">Amount</th><th className="num">Money effect</th><th>By</th></tr></thead>
          <tbody>
            {(list.data ?? []).map((e: any) => (
              <tr key={e.id} className="tr--clickable" onClick={async () => setOpen(await get(`/reports/entries/${e.id}`))}>
                <td className="small">{e.entry_date}<div className="muted">{fmtTime(e.created_at)}</div></td>
                <td><BizTag id={e.business_id} /></td>
                <td className="small">{TYPE_LABEL[e.type] ?? e.type}</td>
                <td className="small">{e.memo}</td>
                <td className="num"><Money c={e.amount} /></td>
                <td className="num">{e.cash_effect ? <Money c={e.cash_effect} signed /> : <span className="muted">—</span>}</td>
                <td className="small muted">{e.created_by_name}</td>
              </tr>
            ))}
            {!list.loading && !list.data?.length && <tr><td colSpan={7} className="muted">No transactions.</td></tr>}
          </tbody>
        </table>
      </div>
      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title="Transaction details" width="md">
        {open && (
          <div className="form-stack">
            <p><strong>{TYPE_LABEL[open.type] ?? open.type}</strong> · {open.entry_date}<br /><span className="small">{open.memo}</span></p>
            <table>
              <thead><tr><th>Account</th><th>Detail</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
              <tbody>{open.lines.map((l: any) => (
                <tr key={l.id}><td>{ACCOUNT_LABEL[l.account]}</td><td className="small">{l.method_name ?? l.customer_name ?? l.supplier_name ?? l.category ?? ''}</td>
                  <td className="num">{l.amount > 0 ? money(l.amount) : ''}</td><td className="num">{l.amount < 0 ? money(-l.amount) : ''}</td></tr>
              ))}</tbody>
            </table>
            <p className="small muted">For accountants: every transaction balances (debits = credits). Recorded {fmtTime(open.created_at)}.{open.reverses_id ? ' This entry reverses an earlier one.' : ''}</p>
          </div>
        )}
      </Modal>
    </>
  );
}
