// Store reports: everything a shopkeeper looks at for a period, compared with the
// period just before — summary cards, profit & loss, sales by day, best sellers
// with profit, slow movers, low stock, cashiers, payment methods, expenses,
// customers, debts, purchases. "All transactions" is a second tab.
import { Fragment, useState, type ReactNode } from 'react';
import { BarChart3, Printer } from 'lucide-react';
import { get, money, num } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Tabs } from '../components/Tabs';
import { StatusBadge } from '../components/StatusBadge';
import { PageSkeleton } from '../components/LoadingSpinner';
import { DateRange, ErrorBox, Kpi, PageHeader, useLoad } from '../components/ui';
import { Ledger } from './ReportsPage';

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

function Bar({ value, max, tone = 'var(--primary)' }: { value: number; max: number; tone?: string }) {
  return <div className="bar"><span style={{ width: `${max > 0 ? Math.max(2, Math.round((Math.max(value, 0) / max) * 100)) : 0}%`, background: tone }} /></div>;
}

function Panel({ kicker, title, children, wide }: { kicker: string; title: string; children: ReactNode; wide?: boolean }) {
  return <div className={`panel ${wide ? 'panel--wide' : ''}`}><div className="panel__header"><div><p>{kicker}</p><h2>{title}</h2></div></div>{children}</div>;
}

export function StoreReports() {
  const { business, businessName, today } = useAuth();
  const [tab, setTab] = useState('report');
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const r = useLoad(() => (tab === 'report' ? get('/reports/business', { business, from, to }) : Promise.resolve(null)), [business, from, to, tab === 'report']);
  const d = r.data;

  return (
    <div className="module-page">
      <PageHeader icon={<BarChart3 size={22} />} title={`Reports — ${businessName(business)}`} subtitle={d ? `${d.from} to ${d.to} · compared with ${d.previous.from} to ${d.previous.to}` : 'Sales, profit, stock and debts'}
        actions={tab === 'report' ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button> : undefined} />
      <div className="panel no-print" style={{ paddingBottom: 0 }}><Tabs tabs={[{ key: 'report', label: 'Report' }, { key: 'ledger', label: 'All transactions' }]} activeTab={tab} onTabChange={setTab} /></div>
      {tab === 'ledger' ? <div className="panel"><Ledger scope={business} /></div> : (
        <>
          <div className="no-print"><DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} /></div>
          <ErrorBox error={r.error} />
          {!d && !r.error && <PageSkeleton />}
          {d && <Report d={d} />}
        </>
      )}
    </div>
  );
}

function Report({ d }: { d: any }) {
  const p = d.profit, pp = d.previous.profit, s = d.sales, ps = d.previous.sales;
  const gross = p.revenue - p.cogs;
  const avg = s.count ? Math.round(s.net / s.count) : 0;
  const maxDay = Math.max(1, ...d.daily.map((x: any) => x.revenue));
  const maxProduct = Math.max(1, ...d.products.map((x: any) => x.revenue));
  const expTotal = d.expenses.reduce((t: number, e: any) => t + e.total, 0);
  const paidTotal = d.methods.reduce((t: number, m: any) => t + m.total, 0);
  const cashierMax = Math.max(1, ...d.cashiers.map((c: any) => c.total));

  return (
    <div className="print-area form-stack">
      <img className="print-only print-logo" src="/logo-full.svg" alt="Meecaad" />
      <h3 className="print-only">Meecaad Store — {d.from} to {d.to}</h3>

      {/* The key figures, compared with the period before */}
      <section className="kpi-grid">
        <Kpi label="Sales" value={money(p.revenue)} now={p.revenue} before={pp.revenue} sub={`${s.count} sales · average ${money(avg)}`} />
        <Kpi label="Gross profit" value={money(gross)} now={gross} before={pp.revenue - pp.cogs} sub={`margin ${pct(gross, p.revenue)} · cost of goods ${money(p.cogs)}`} />
        <Kpi label="Expenses" value={money(p.expenses)} now={p.expenses} before={pp.expenses} lowerIsBetter sub={`${pct(p.expenses, p.revenue)} of sales`} />
        <Kpi label="Net profit" value={money(p.profit)} now={p.profit} before={pp.profit} tone={p.profit < 0 ? 'red' : 'green'} sub={`margin ${pct(p.profit, p.revenue)}`} />
      </section>
      <section className="kpi-grid">
        <Kpi label="Items sold" value={num(s.items)} sub={`${num(d.products.length)} different products`} />
        <Kpi label="Given on credit" value={money(d.credit.given)} sub={`paid back ${money(d.credit.collected)}`} />
        <Kpi label="Customers owe" value={money(d.debtors.total)} sub={`${d.debtors.count} customers`} tone={d.debtors.total > 0 ? undefined : 'green'} />
        <Kpi label="Owed to suppliers" value={money(d.suppliers.total)} sub={`${d.suppliers.count} suppliers`} />
        <Kpi label="Stock value (at cost)" value={money(d.stock.value)} sub={`${d.stock.items} products · ${d.low.length} low or out`} tone={d.low.length ? 'red' : undefined} />
        <Kpi label="Returns & cancellations" value={money(s.returned + s.cancelled_total)} now={s.returned + s.cancelled_total} before={ps.returned + ps.cancelled_total} lowerIsBetter sub={`${s.returns} returns · ${s.cancelled} cancelled`} />
      </section>

      <div className="grid-2">
        <Panel kicker="Profit and loss" title="How the profit is made">
          <div className="kv">
            <span>Sales</span><span>{money(p.revenue)}</span>
            <span>− Cost of the goods sold</span><span>{money(p.cogs)}</span>
            <span className="kv-total">= Gross profit</span><span className="kv-total">{money(gross)}</span>
            <span>− Expenses</span><span>{money(p.expenses)}</span>
            <span>− Stock losses (waste, damage, counts)</span><span>{money(p.losses)}</span>
            <span>− Cash shortages (+ overages)</span><span>{money(p.cashDiff)}</span>
            <span className="kv-total">= Net profit</span><span className="kv-total" style={{ color: p.profit < 0 ? '#b91c1c' : '#15803d' }}>{money(p.profit)}</span>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Before: sales {money(pp.revenue)}, net profit {money(pp.profit)}. Discounts given: {money(s.discount)}.</p>
        </Panel>
        <Panel kicker="Day by day" title="Sales and profit">
          <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
            <table>
              <thead><tr><th>Date</th><th>Sales</th><th className="num">Profit</th></tr></thead>
              <tbody>
                {[...d.daily].reverse().map((x: any) => (
                  <tr key={x.entry_date}><td className="small">{x.entry_date}</td>
                    <td style={{ minWidth: 150 }}><strong>{money(x.revenue)}</strong><Bar value={x.revenue} max={maxDay} /></td>
                    <td className="num" style={{ color: x.profit < 0 ? '#b91c1c' : undefined }}>{money(x.profit)}</td></tr>
                ))}
                {!d.daily.length && <tr><td colSpan={3} className="muted">No sales in this period.</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel kicker="Products" title="Best sellers — what brings the money and the profit" wide>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Product</th><th className="num">Sold</th><th>Sales</th><th className="num">Cost</th><th className="num">Profit</th><th className="num">Margin</th></tr></thead>
            <tbody>
              {d.products.slice(0, 15).map((x: any) => (
                <tr key={x.product_id}><td><strong>{x.name}</strong><div className="small muted">in {x.sales} sales</div></td><td className="num">{num(x.qty)}</td>
                  <td style={{ minWidth: 150 }}>{money(x.revenue)}<Bar value={x.revenue} max={maxProduct} tone="#f59e0b" /></td>
                  <td className="num">{money(x.cost)}</td><td className="num" style={{ color: x.revenue - x.cost < 0 ? '#b91c1c' : '#15803d' }}>{money(x.revenue - x.cost)}</td>
                  <td className="num">{pct(x.revenue - x.cost, x.revenue)}</td></tr>
              ))}
              {!d.products.length && <tr><td colSpan={6} className="muted">Nothing sold in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid-2">
        <Panel kicker="Stock" title="Not selling (in stock, no sale in this period)">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Product</th><th className="num">In stock</th><th className="num">Money tied up</th><th>Last sold</th></tr></thead>
              <tbody>
                {d.slow.map((x: any) => <tr key={x.id}><td>{x.name}</td><td className="num">{num(x.stock_qty)} {x.unit}</td><td className="num">{money(x.value)}</td><td className="small">{x.last_sold ?? <span className="muted">never</span>}</td></tr>)}
                {!d.slow.length && <tr><td colSpan={4} className="muted">Every product in stock sold at least once.</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel kicker="Stock" title="Low or out of stock — buy soon">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Product</th><th className="num">Left</th><th className="num">Low level</th></tr></thead>
              <tbody>
                {d.low.map((x: any) => <tr key={x.id}><td>{x.name}</td><td className="num">{num(x.stock_qty)} {x.unit} {x.stock_qty <= 0 ? <StatusBadge label="Out" tone="red" /> : <StatusBadge label="Low" tone="yellow" />}</td><td className="num">{num(x.reorder_level)}</td></tr>)}
                {!d.low.length && <tr><td colSpan={3} className="muted">Nothing is low.</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div className="grid-2">
        <Panel kicker="Sales" title="How customers paid">
          <div className="form-stack">
            {d.methods.map((m: any) => <div key={m.method}><div className="row row--between small"><span>{m.method}</span><span><strong>{money(m.total)}</strong> · {pct(m.total, paidTotal + d.credit.given)}</span></div><Bar value={m.total} max={paidTotal + d.credit.given} /></div>)}
            <div><div className="row row--between small"><span>On credit</span><span><strong>{money(d.credit.given)}</strong> · {pct(d.credit.given, paidTotal + d.credit.given)}</span></div><Bar value={d.credit.given} max={paidTotal + d.credit.given} tone="#f59e0b" /></div>
          </div>
        </Panel>
        <Panel kicker="Team" title="Sales by cashier">
          <div className="form-stack">
            {d.cashiers.map((c: any) => <div key={c.name}><div className="row row--between small"><span><strong>{c.name}</strong> · {c.count} sales</span><span><strong>{money(c.total)}</strong></span></div><Bar value={c.total} max={cashierMax} tone="#0ea5e9" /></div>)}
            {!d.cashiers.length && <span className="muted">No sales.</span>}
          </div>
        </Panel>
      </div>

      <div className="grid-2">
        <Panel kicker="Expenses" title="Where the money went">
          <div className="form-stack">
            {d.expenses.map((e: any) => <div key={e.category}><div className="row row--between small"><span>{e.category}</span><span><strong>{money(e.total)}</strong> · {pct(e.total, expTotal)}</span></div><Bar value={e.total} max={d.expenses[0]?.total ?? 0} tone="#ef4444" /></div>)}
            {!d.expenses.length && <span className="muted">No expenses in this period.</span>}
          </div>
        </Panel>
        <Panel kicker="Buying" title="Purchases">
          <div className="kv">
            <span>Purchases made</span><span>{d.purchases.count}</span>
            <span>Bought for</span><span>{money(d.purchases.total)}</span>
            <span>Paid</span><span>{money(d.purchases.paid)}</span>
            <span className="kv-total">Still owed on these</span><span className="kv-total">{money(d.purchases.total - d.purchases.paid)}</span>
          </div>
        </Panel>
      </div>

      <div className="grid-2">
        <Panel kicker="Customers" title="Best customers">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Customer</th><th className="num">Sales</th><th className="num">Bought for</th></tr></thead>
              <tbody>
                {d.customers.map((c: any) => <tr key={c.id}><td>{c.name}</td><td className="num">{c.count}</td><td className="num">{money(c.total)}</td></tr>)}
                {!d.customers.length && <tr><td colSpan={3} className="muted">No named customers in this period (walk-in sales only).</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel kicker="Debts now" title="Who owes us · whom we owe">
          <div className="kv">
            {d.debtors.top.map((c: any) => <Fragment key={c.name}><span>{c.name}{c.last_paid ? <span className="small muted"> · paid {c.last_paid}</span> : ''}</span><span>{money(c.balance)}</span></Fragment>)}
            <span className="kv-total">Customers owe us</span><span className="kv-total">{money(d.debtors.total)}</span>
            {d.suppliers.top.map((x: any) => <Fragment key={x.name}><span>{x.name}</span><span>{money(x.balance)}</span></Fragment>)}
            <span className="kv-total">We owe suppliers</span><span className="kv-total">{money(d.suppliers.total)}</span>
          </div>
        </Panel>
      </div>
    </div>
  );
}
