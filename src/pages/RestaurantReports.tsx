// Restaurant dashboard and reports: only what the restaurant has —
// orders, sales, payments, expenses, customer debts and best sellers.
// Profit here is simply sales − expenses.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, LayoutDashboard, Printer, RefreshCw } from 'lucide-react';
import { get, money, num } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { PageSkeleton } from '../components/LoadingSpinner';
import { DateRange, ErrorBox, Money, PageHeader, Stat, fmtTime, useLoad } from '../components/ui';
import { ItemPicture } from './RestaurantPage';

const R = 'restaurant';

/** Money found short (or over) when shifts were closed also counts in profit. */
function ShiftDiff({ c }: { c: number }) {
  if (!c) return null;
  return <span style={{ display: 'block', color: c > 0 ? '#b91c1c' : undefined }}>includes {money(Math.abs(c))} cash {c > 0 ? 'short' : 'over'} at shift closings</span>;
}
const PERIODS = [
  { key: 'today', label: 'Today', vs: 'yesterday', vsLabel: 'yesterday' },
  { key: 'week', label: 'This week', vs: 'lastWeek', vsLabel: 'same days last week' },
  { key: 'month', label: 'This month', vs: 'lastMonth', vsLabel: 'same days last month' },
] as const;

/** Change vs the earlier period; for expenses a rise is shown as bad (`lowerIsBetter`). */
function Trend({ now, before, label, lowerIsBetter }: { now: number; before: number; label: string; lowerIsBetter?: boolean }) {
  if (!now && !before) return <span className="muted">—</span>;
  const diff = now - before;
  const good = lowerIsBetter ? diff <= 0 : diff >= 0;
  const pct = before ? Math.round((diff / Math.abs(before)) * 100) : null;
  return <span className={`trend ${good ? 'trend--up' : 'trend--down'}`}>{diff >= 0 ? '▲' : '▼'} {money(Math.abs(diff))}{pct !== null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''} vs {label}</span>;
}

const sum = (rows: any[] | undefined, f: string) => (rows ?? []).reduce((s, r) => s + (r[f] ?? 0), 0);

// ── Dashboard ───────────────────────────────────────────────────
export function RestaurantDashboard() {
  const { path, today } = useAuth();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(PERIODS[0]);
  const dash = useLoad(() => get('/dashboard', { business: R }), []);
  const [from, to] = dash.data?.periods?.[period.key] ?? [today, today];
  const summary = useLoad(() => get('/reports/summary', { business: R, from, to }), [from, to]);
  const orders = useLoad(() => get('/restaurant/orders'), []);
  const latest = useLoad(() => get('/sales', { business: R, from: today, to: today }), [today]);

  if (!dash.data) return dash.error ? <ErrorBox error={dash.error} /> : <PageSkeleton />;
  const now = dash.data.figures[period.key][R];
  const before = dash.data.figures[period.vs][R];
  const s = summary.data;
  const count = sum(s?.counts, 'sales');
  const pending = orders.data ?? [];
  const owed = sum(dash.data.receivable, 'total');
  const reload = () => { dash.reload(); summary.reload(); orders.reload(); latest.reload(); };

  return (
    <div className="dashboard">
      <PageHeader icon={<LayoutDashboard size={22} />} title="Restaurant dashboard" subtitle={dash.data.today}
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={reload}><RefreshCw size={14} /> Refresh</button>} />
      <div className="scope-tabs">
        {PERIODS.map((p) => <button key={p.key} type="button" className={period.key === p.key ? 'active' : ''} onClick={() => setPeriod(p)}>{p.label}</button>)}
      </div>

      <section className="stat-grid">
        <Stat label={`Sales · ${period.label}`} value={money(now.revenue)} sub={<Trend now={now.revenue} before={before.revenue} label={period.vsLabel} />} />
        <Stat label="Expenses" value={money(now.expenses)} sub={<Trend now={now.expenses} before={before.expenses} label={period.vsLabel} lowerIsBetter />} />
        <Stat label="Profit (sales − expenses)" value={money(now.profit)} tone={now.profit < 0 ? 'red' : 'green'} sub={<><Trend now={now.profit} before={before.profit} label={period.vsLabel} /><ShiftDiff c={now.cashDiff} /></>} />
        <Stat label="Paid orders" value={num(count)} sub={count ? `average ${money(Math.round(now.revenue / count))}` : 'none yet'} />
      </section>

      <section className="stat-grid">
        <button type="button" className="stat stat--link" onClick={() => navigate(path('/order-list'))}>
          <span className="stat__label">Waiting to be paid</span>
          <strong className="stat__value">{pending.length} {pending.length === 1 ? 'order' : 'orders'}</strong>
          <span className="stat__sub">{money(sum(pending, 'total'))} · open Orders →</span>
        </button>
        <button type="button" className="stat stat--link" onClick={() => navigate(path('/customers'))}>
          <span className="stat__label">Customers owe</span>
          <strong className="stat__value">{money(owed)}</strong>
          <span className="stat__sub">{sum(dash.data.receivable, 'parties')} customers · open Customers →</span>
        </button>
        {(s?.methods ?? []).map((m: any) => (
          <Stat key={m.method_id} label={`Received · ${m.method_name}`} value={money(m.total)} sub={period.label} />
        ))}
      </section>

      <section className="work-grid">
        <div className="panel">
          <div className="panel__header"><div><p>{period.label}</p><h2>Best sellers</h2></div></div>
          {!(s?.topProducts ?? []).length ? <p className="muted">No sales yet.</p> : (
            <ul className="rank-list">
              {s.topProducts.slice(0, 8).map((p: any, i: number) => (
                <li key={p.product_id}>
                  <span className="rank">{i + 1}</span><ItemPicture item={{ id: p.product_id, name: p.name, image_v: p.image_v }} size={30} />
                  <span className="rank-name">{p.name}</span><span className="muted">{num(p.qty)} sold</span><strong>{money(p.revenue)}</strong>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="panel">
          <div className="panel__header"><div><p>Today</p><h2>Latest sales</h2></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(path('/sales'))}>All sales</button></div>
          {!(latest.data ?? []).length ? <p className="muted">No sales today yet.</p> : (
            <ul className="rank-list">
              {latest.data.slice(0, 8).map((x: any) => (
                <li key={x.id} style={{ opacity: x.status === 'voided' ? 0.5 : 1 }}>
                  <span className="rank">#{x.number}</span><span className="rank-name small">{fmtTime(x.created_at)}{x.status === 'voided' ? ' · cancelled' : ''}</span>
                  <span className="muted small">{x.payments_text ?? (x.credit_amount ? 'on credit' : '')}</span><strong>{money(x.total - x.returned_amount)}</strong>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      {dash.data.alerts.length > 0 && (
        <div className="panel">
          <div className="panel__header"><div><p>Alerts</p><h2>Needs attention</h2></div></div>
          <ul className="alert-list">
            {dash.data.alerts.map((a: any, i: number) => <li key={i} className={`alert--${a.level}`} onClick={() => a.link === '/customers' && navigate(path('/customers'))}><strong>{a.title}</strong><span>{a.detail}</span></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Reports ─────────────────────────────────────────────────────
export function RestaurantReports() {
  const { today } = useAuth();
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const r = useLoad(() => get('/reports/summary', { business: R, from, to }), [from, to]);
  const s = r.data;
  const p = s?.profit?.[R];
  const count = sum(s?.counts, 'sales');
  const days = s ? [...new Set<string>([...s.daily.map((d: any) => d.entry_date), ...s.counts.map((c: any) => c.entry_date)])].sort().reverse() : [];
  const credit = s?.credit?.[0] ?? { given: 0, collected: 0 };

  return (
    <div className="module-page">
      <PageHeader icon={<BarChart3 size={22} />} title="Restaurant reports" subtitle={`${s?.from ?? from} to ${s?.to ?? to}`}
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button>} />
      <div className="no-print"><DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} /></div>
      <ErrorBox error={r.error} />
      {s && p && (
        <div className="print-area form-stack">
          <h3 className="print-only">Meecaad Restaurant &amp; Cafe — {s.from} to {s.to}</h3>
          <section className="stat-grid">
            <Stat label="Sales" value={money(p.revenue)} />
            <Stat label="Expenses" value={money(p.expenses)} />
            <Stat label="Profit (sales − expenses)" value={money(p.profit)} tone={p.profit < 0 ? 'red' : 'green'} sub={<ShiftDiff c={p.cashDiff} />} />
            <Stat label="Paid orders" value={num(count)} sub={count ? `average ${money(Math.round(p.revenue / count))}` : ''} />
          </section>

          <div className="grid-2">
            <div className="panel">
              <div className="panel__header"><div><p>Money received for sales</p><h2>By payment method</h2></div></div>
              <table><tbody>
                {s.methods.map((m: any) => <tr key={m.method_id}><td>{m.method_name}</td><td className="num"><Money c={m.total} /></td></tr>)}
                {credit.given > 0 && <tr><td>Given on credit</td><td className="num"><Money c={credit.given} /></td></tr>}
                {credit.collected > 0 && <tr><td>Debts collected</td><td className="num"><Money c={credit.collected} /></td></tr>}
                {!s.methods.length && !credit.given && <tr><td className="muted">No sales in this period.</td></tr>}
              </tbody></table>
            </div>
            <div className="panel">
              <div className="panel__header"><div><p>Where the money went</p><h2>Expenses by category</h2></div></div>
              <table><tbody>
                {s.expenses.map((e: any) => <tr key={e.category}><td>{e.category}</td><td className="num"><Money c={e.total} /></td></tr>)}
                {!s.expenses.length && <tr><td className="muted">No expenses in this period.</td></tr>}
              </tbody></table>
            </div>
          </div>

          <div className="panel">
            <div className="panel__header"><div><p>What sold</p><h2>Best sellers</h2></div></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Item</th><th className="num">Quantity</th><th className="num">Sales</th><th className="num">Share</th></tr></thead>
                <tbody>
                  {s.topProducts.map((x: any) => (
                    <tr key={x.product_id}><td><div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}><ItemPicture item={{ id: x.product_id, name: x.name, image_v: x.image_v }} size={28} />{x.name}</div></td>
                      <td className="num">{num(x.qty)}</td><td className="num">{money(x.revenue)}</td>
                      <td className="num">{p.revenue ? `${Math.round((x.revenue / p.revenue) * 100)}%` : '—'}</td></tr>
                  ))}
                  {!s.topProducts.length && <tr><td colSpan={4} className="muted">No sales in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel__header"><div><p>Day by day</p><h2>Sales, expenses and profit</h2></div></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th className="num">Orders</th><th className="num">Sales</th><th className="num">Expenses</th><th className="num">Profit</th></tr></thead>
                <tbody>
                  {days.map((d) => {
                    const row = s.daily.find((x: any) => x.entry_date === d) ?? { revenue: 0, profit: 0 };
                    return (
                      <tr key={d}><td>{d}</td><td className="num">{num(s.counts.find((c: any) => c.entry_date === d)?.sales ?? 0)}</td>
                        <td className="num">{money(row.revenue)}</td><td className="num">{money(row.revenue - row.profit)}</td><td className="num"><Money c={row.profit} strong /></td></tr>
                    );
                  })}
                  {!days.length && <tr><td colSpan={5} className="muted">Nothing in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

