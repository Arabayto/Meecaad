import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Coffee, Fuel, LayoutDashboard, RefreshCw, Store } from 'lucide-react';
import { get, money } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { PageSkeleton } from '../components/LoadingSpinner';
import { BizTag, ErrorBox, Money, PageHeader, Stat, fmtTime, useLoad } from '../components/ui';

type Pnl = { revenue: number; cogs: number; expenses: number; losses: number; cashDiff: number; grossProfit: number; profit: number };
const PERIODS = [
  { key: 'today', label: 'Today', vs: 'yesterday', vsLabel: 'yesterday' },
  { key: 'week', label: 'This week', vs: 'lastWeek', vsLabel: 'same days last week' },
  { key: 'month', label: 'This month', vs: 'lastMonth', vsLabel: 'same days last month' },
] as const;
const ICONS: Record<string, typeof Store> = { restaurant: Coffee, fuel: Fuel, store: Store };
// Cash lines of these entry types move money between accounts; they are neither income nor spending.
const INTERNAL = ['transfer', 'transfer_void', 'closing_diff', 'closing_reopen'];

function Trend({ now, before, label }: { now: number; before: number; label: string }) {
  if (!before && !now) return <span className="trend muted">No activity {label} either</span>;
  const diff = now - before;
  const pct = before ? Math.round((diff / Math.abs(before)) * 100) : null;
  return (
    <span className={`trend ${diff >= 0 ? 'trend--up' : 'trend--down'}`}>
      {diff >= 0 ? '▲' : '▼'} {money(Math.abs(diff))}{pct !== null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''} vs {label}
    </span>
  );
}

// Alert links are business-relative; the fuel station's page is /pumps.
const ALERT_PAGE: Record<string, string> = { '/fuel': '/pumps' };

export function DashboardPage() {
  const { businesses, businessName, business, path } = useAuth();
  const navigate = useNavigate();
  // In a business portal the dashboard is that business only; the owner admin can switch.
  const [picked, setScope] = useState('all');
  const scope = business || picked;
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(PERIODS[0]);
  const { data: d, loading, error, reload } = useLoad(() => get('/dashboard', { business: scope }), [scope]);

  if (loading && !d) return <PageSkeleton />;
  if (!d) return <ErrorBox error={error} />;

  // Draw from the selection the data was loaded for (the tabs above already show the new choice).
  const view: string = d.business;
  const key = view;
  const now: Pnl = d.figures[period.key][key];
  const before: Pnl = d.figures[period.vs][key];
  const sumBy = (rows: any[], field = 'total') => rows.reduce((s, r) => s + (r[field] ?? 0), 0);
  const cashTotal = sumBy(d.cash, 'balance');
  const owedToUs = sumBy(d.receivable);
  const weOwe = sumBy(d.payable);
  const stockValue = sumBy(d.inventory, 'value');
  const flow = d.flow.filter((f: any) => !INTERNAL.includes(f.entry_type));
  const moneyIn = sumBy(flow, 'money_in');
  const moneyOut = sumBy(flow, 'money_out');
  const outBy = (types: string[]) => flow.filter((f: any) => types.some((t) => f.entry_type.startsWith(t))).reduce((s: number, f: any) => s + f.money_out - f.money_in, 0);
  // From the owner admin, an alert opens the page in that business's own portal.
  const alertLink = (a: any) => (business ? path(ALERT_PAGE[a.link] ?? a.link) : `/${a.business}${ALERT_PAGE[a.link] ?? a.link}`);
  const redAlerts = d.alerts.filter((a: any) => a.level === 'red').length;

  return (
    <div className="dashboard">
      <PageHeader icon={<LayoutDashboard size={22} />} title={view === 'all' ? 'All businesses' : businessName(view)}
        subtitle={`Owner overview · ${d.today}`}
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => reload()}><RefreshCw size={14} /> Refresh</button>} />

      <div className="row row--between">
        {!business && <div className="scope-tabs" role="tablist">
          <button type="button" className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All Businesses</button>
          {businesses.map((b) => <button key={b.id} type="button" className={scope === b.id ? 'active' : ''} onClick={() => setScope(b.id)}>{businessName(b.id)}</button>)}
        </div>}
        <div className="scope-tabs">
          {PERIODS.map((p) => <button key={p.key} type="button" className={period.key === p.key ? 'active' : ''} onClick={() => setPeriod(p)}>{p.label}</button>)}
        </div>
      </div>

      <section className="stat-grid">
        <Stat label={`Sales · ${period.label}`} value={money(now.revenue)} sub={<Trend now={now.revenue} before={before.revenue} label={period.vsLabel} />} />
        <Stat label="Cost of goods sold" value={money(now.cogs)} sub={`Gross profit ${money(now.grossProfit)}`} />
        <Stat label="Expenses" value={money(now.expenses)} sub="Rent, salaries, fuel, bills…" />
        <Stat label="Losses & cash differences" value={money(now.losses + now.cashDiff)} tone={now.losses + now.cashDiff > 0 ? 'red' : undefined}
          sub={`Stock loss ${money(now.losses)} · Cash ${money(now.cashDiff)}`} />
        <Stat label="Estimated profit" value={money(now.profit)} tone={now.profit < 0 ? 'red' : 'green'} sub={<Trend now={now.profit} before={before.profit} label={period.vsLabel} />} />
      </section>

      <section className="stat-grid">
        <Stat label="Money available now" value={money(cashTotal)} tone={cashTotal < 0 ? 'red' : undefined} sub="Cash + mobile money, all accounts" />
        <Stat label="Customers owe us" value={money(owedToUs)} sub={`${sumBy(d.receivable, 'parties')} customers`} />
        <Stat label="We owe suppliers" value={money(weOwe)} sub={`${sumBy(d.payable, 'parties')} suppliers`} />
        <Stat label="Stock value (at cost)" value={money(stockValue)} />
        <Stat label="Money received today" value={money(moneyIn)}
          sub={`Paid out ${money(moneyOut)}: expenses ${money(outBy(['expense']))}, stock & suppliers ${money(outBy(['purchase', 'supplier_payment']))}`} />
      </section>

      {view === 'all' && (
        <section className="biz-cards">
          {businesses.map((b) => {
            const Icon = ICONS[b.kind];
            const t: Pnl = d.figures[period.key][b.id];
            const y: Pnl = d.figures[period.vs][b.id];
            const cash = d.cash.filter((c: any) => c.business_id === b.id);
            const last = d.closings.find((c: any) => c.business_id === b.id)?.last_closed;
            return (
              <div className="biz-card" key={b.id}>
                <div className="biz-card__head">
                  <h3 className="row" style={{ flexWrap: 'nowrap' }}><Icon size={18} /> {businessName(b.id)}</h3>
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => setScope(b.id)}>Details</button>
                </div>
                <div className="kv">
                  <span>Sales ({period.label.toLowerCase()})</span><span>{money(t.revenue)}</span>
                  <span>Cost of goods</span><span>{money(t.cogs)}</span>
                  <span>Expenses</span><span>{money(t.expenses)}</span>
                  <span>Losses & cash differences</span><span style={{ color: t.losses + t.cashDiff > 0 ? '#b91c1c' : undefined }}>{money(t.losses + t.cashDiff)}</span>
                  <span className="kv-total">Profit</span><span className="kv-total" style={{ color: t.profit < 0 ? '#b91c1c' : '#15803d' }}>{money(t.profit)}</span>
                </div>
                <Trend now={t.revenue} before={y.revenue} label={period.vsLabel} />
                <div className="kv">
                  {cash.map((c: any) => <Fragment key={c.method_id}><span>{c.method_name}</span><span><Money c={c.balance} /></span></Fragment>)}
                  <span>Customers owe</span><span>{money(d.receivable.find((r: any) => r.business_id === b.id)?.total)}</span>
                  <span>Owed to suppliers</span><span>{money(d.payable.find((r: any) => r.business_id === b.id)?.total)}</span>
                  {b.kind !== 'restaurant' && <><span>Last daily closing</span><span>{last ?? 'Never'}</span></>}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="work-grid">
        <div className="panel panel--wide">
          <div className="panel__header">
            <div><p>Compare</p><h2>Sales and profit over time</h2></div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Period</th><th className="num">Sales</th><th className="num">Costs & expenses</th><th className="num">Profit</th><th>Compared with</th><th className="num">Sales</th><th className="num">Profit</th></tr></thead>
              <tbody>
                {PERIODS.map((p) => {
                  const a: Pnl = d.figures[p.key][key], b: Pnl = d.figures[p.vs][key];
                  return (
                    <tr key={p.key}>
                      <td><strong>{p.label}</strong></td>
                      <td className="num">{money(a.revenue)}</td>
                      <td className="num">{money(a.revenue - a.profit)}</td>
                      <td className="num"><Money c={a.profit} strong /></td>
                      <td className="muted">{p.vsLabel}</td>
                      <td className="num">{money(b.revenue)}</td>
                      <td className="num"><Money c={b.profit} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="panel__header" style={{ marginTop: 20 }}>
            <div><p>Where the money is</p><h2>Cash and mobile money balances</h2></div>
            {business !== 'restaurant' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(path('/money'))}>Open accounts</button>}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Business</th>{[...new Set(d.cash.map((c: any) => c.method_name))].map((m: any) => <th key={m} className="num">{m}</th>)}<th className="num">Total</th></tr></thead>
              <tbody>
                {d.scope.map((b: string) => {
                  const rows = d.cash.filter((c: any) => c.business_id === b);
                  return (
                    <tr key={b}>
                      <td><BizTag id={b} /></td>
                      {[...new Set(d.cash.map((c: any) => c.method_name))].map((m: any) => <td key={m} className="num"><Money c={rows.find((r: any) => r.method_name === m)?.balance ?? 0} /></td>)}
                      <td className="num"><Money c={sumBy(rows, 'balance')} strong /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel__header">
            <div><p>Needs attention</p><h2>Alerts {d.alerts.length ? `(${d.alerts.length})` : ''}</h2></div>
            <AlertTriangle size={18} style={{ color: redAlerts ? '#dc2626' : '#0b8f08' }} />
          </div>
          {d.alerts.length === 0 ? <div className="mc-note">No problems found. Stock, cash closings and fuel are in order.</div> : (
            <ul className="alert-list">
              {d.alerts.slice(0, 25).map((a: any, i: number) => (
                <li key={i} className={`alert--${a.level}`} onClick={() => navigate(alertLink(a))}>
                  <strong>{a.title} <BizTag id={a.business} /></strong>
                  <span>{a.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel__header">
          <div><p>Recent activity</p><h2>Latest transactions {view === 'all' ? 'from all businesses' : `· ${businessName(view)}`}</h2></div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(path('/reports?tab=ledger'))}>All transactions</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Business</th><th>What happened</th><th className="num">Amount</th><th>By</th></tr></thead>
            <tbody>
              {d.activity.map((a: any) => (
                <tr key={a.id}>
                  <td className="small">{fmtTime(a.created_at)}{a.entry_date !== a.created_at.slice(0, 10) ? <div className="muted">for {a.entry_date}</div> : null}</td>
                  <td><BizTag id={a.business_id} /></td>
                  <td>{a.memo}</td>
                  <td className="num"><Money c={a.amount} /></td>
                  <td className="small muted">{a.created_by_name}</td>
                </tr>
              ))}
              {!d.activity.length && <tr><td colSpan={5} className="muted">Nothing recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
