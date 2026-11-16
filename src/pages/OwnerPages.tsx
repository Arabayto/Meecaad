// Owner admin: all businesses together, kept simple.
//   Overview — one card per business (Sales, Spent, Profit), the total, plain-words
//              lines, and what needs attention.
//   Reports  — by business, day by day, where the money went, how customers paid.
// "Spent" = everything that was paid out to earn the sales: cost of goods, expenses,
// losses and cash shortages. Profit = Sales − Spent.
import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, BarChart3, ChevronRight, Coffee, Fuel, Home, Lightbulb, Printer, RefreshCw, Store } from 'lucide-react';
import { get, money } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { PageSkeleton } from '../components/LoadingSpinner';
import { Tabs } from '../components/Tabs';
import { BizTag, DateRange, ErrorBox, PageHeader, Stat, useLoad, usePolling } from '../components/ui';
import { Ledger } from './ReportsPage';

const PERIODS = [
  { key: 'today', label: 'Today', vs: 'yesterday', vsLabel: 'yesterday' },
  { key: 'week', label: 'This week', vs: 'lastWeek', vsLabel: 'the same days last week' },
  { key: 'month', label: 'This month', vs: 'lastMonth', vsLabel: 'the same days last month' },
] as const;
const ICONS: Record<string, typeof Store> = { restaurant: Coffee, fuel: Fuel, store: Store };
type Pnl = { revenue: number; profit: number };
const spent = (p: Pnl) => p.revenue - p.profit;
const pct = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);
const sum = (rows: any[], f: string) => rows.reduce((t, r) => t + (r[f] ?? 0), 0);

/** ▲ 12% vs yesterday */
function Trend({ now, before, label }: { now: number; before: number; label: string }) {
  const p = pct(now, before);
  if (p === null) return <span className="small muted">{now || before ? `nothing ${label}` : 'no sales yet'}</span>;
  return <span className={`trend ${p >= 0 ? 'trend--up' : 'trend--down'}`}>{p >= 0 ? '▲' : '▼'} {Math.abs(p)}% vs {label}</span>;
}

// ── Overview ────────────────────────────────────────────────────
export function OwnerOverview() {
  const { businesses, businessName } = useAuth();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(PERIODS[0]);
  const [allAlerts, setAllAlerts] = useState(false);
  const { data: d, error, reload } = useLoad(() => get('/dashboard', { business: 'all' }), []);
  usePolling(reload, 60000);
  if (!d) return error ? <ErrorBox error={error} /> : <PageSkeleton />;

  const f = (k: string, b: string): Pnl => d.figures[k][b];
  const now = f(period.key, 'all'), before = f(period.vs, 'all');
  const owedBy = (b: string) => d.receivable.find((r: any) => r.business_id === b)?.total ?? 0;
  const owed = sum(d.receivable, 'total');
  const weOwe = sum(d.payable, 'total');
  const methods = [...new Set(d.cash.map((c: any) => c.method_name))] as string[];
  const heldBy = (m: string) => d.cash.filter((c: any) => c.method_name === m).reduce((t: number, c: any) => t + c.balance, 0);
  const held = sum(d.cash, 'balance');
  const alerts = [...d.alerts].sort((a: any, b: any) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1));
  const shownAlerts = allAlerts ? alerts : alerts.slice(0, 5);

  // Plain sentences, most important first.
  const top = [...businesses].sort((a, b) => f(period.key, b.id).revenue - f(period.key, a.id).revenue)[0];
  const lines: string[] = [];
  const change = pct(now.revenue, before.revenue);
  if (change !== null) lines.push(`Total sales ${period.label.toLowerCase()} are ${money(now.revenue)} — ${change >= 0 ? `up ${change}%` : `down ${Math.abs(change)}%`} compared with ${period.vsLabel}.`);
  else if (now.revenue > 0) lines.push(`Total sales ${period.label.toLowerCase()} are ${money(now.revenue)}.`);
  if (top && now.revenue > 0 && f(period.key, top.id).revenue > 0 && businesses.length > 1) lines.push(`${businessName(top.id)} brings the most: ${Math.round((f(period.key, top.id).revenue / now.revenue) * 100)}% of all sales.`);
  for (const b of businesses) if (f(period.key, b.id).profit < 0) lines.push(`${businessName(b.id)} is losing money ${period.label.toLowerCase()}: ${money(f(period.key, b.id).profit)} after costs.`);
  if (owed > 0) { const big = [...businesses].sort((a, b) => owedBy(b.id) - owedBy(a.id))[0]; lines.push(`Customers owe you ${money(owed)} in total${big && owedBy(big.id) < owed ? ` — most of it to ${businessName(big.id)} (${money(owedBy(big.id))})` : ''}.`); }
  if (weOwe > 0) lines.push(`You owe suppliers ${money(weOwe)}.`);

  return (
    <div className="dashboard">
      <PageHeader icon={<Home size={22} />} title="All businesses" subtitle={`${d.today} · Hargeisa time`}
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => reload()}><RefreshCw size={14} /> Refresh</button>} />
      <div className="scope-tabs">
        {PERIODS.map((p) => <button key={p.key} type="button" className={period.key === p.key ? 'active' : ''} onClick={() => setPeriod(p)}>{p.label}</button>)}
      </div>

      <section className="owner-cards">
        {businesses.map((b) => {
          const Icon = ICONS[b.kind];
          const t = f(period.key, b.id), y = f(period.vs, b.id);
          return (
            <button type="button" key={b.id} className="owner-card" onClick={() => navigate(`/${b.id}`)} aria-label={`Open ${businessName(b.id)}`}>
              <span className="owner-card__head"><Icon size={18} /> <strong>{businessName(b.id)}</strong><ChevronRight size={16} className="owner-card__go" /></span>
              <span className="owner-card__label">Sales</span>
              <span className="owner-card__big">{money(t.revenue)}</span>
              <Trend now={t.revenue} before={y.revenue} label={period.vsLabel} />
              <span className="kv owner-card__kv">
                <span>Spent</span><span>{money(spent(t))}</span>
                <span className="kv-total">Profit</span><span className="kv-total" style={{ color: t.profit < 0 ? '#b91c1c' : '#15803d' }}>{money(t.profit)}</span>
              </span>
              {owedBy(b.id) > 0 && <span className="small muted">Customers owe {money(owedBy(b.id))}</span>}
            </button>
          );
        })}
      </section>

      <section className="stat-grid">
        <Stat label="All sales" value={money(now.revenue)} sub={<Trend now={now.revenue} before={before.revenue} label={period.vsLabel} />} />
        <Stat label="All spent" value={money(spent(now))} sub="costs, expenses and losses" />
        <Stat label="All profit" value={money(now.profit)} tone={now.profit < 0 ? 'red' : 'green'} sub={<Trend now={now.profit} before={before.profit} label={period.vsLabel} />} />
      </section>

      {lines.length > 0 && (
        <div className="panel">
          <div className="panel__header"><div><p>In plain words</p><h2><Lightbulb size={16} style={{ verticalAlign: -2 }} /> What the numbers say</h2></div></div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>{lines.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}

      <div className="grid-2">
        <div className="panel">
          <div className="panel__header"><div><p>Needs attention</p><h2>{alerts.length ? `${alerts.length} ${alerts.length === 1 ? 'thing' : 'things'} to check` : 'All good'}</h2></div>
            <AlertTriangle size={18} style={{ color: alerts.some((a: any) => a.level === 'red') ? '#dc2626' : '#0b8f08' }} /></div>
          {alerts.length === 0 ? <div className="mc-note">Nothing needs your attention right now.</div> : (
            <>
              <ul className="alert-list">
                {shownAlerts.map((a: any, i: number) => (
                  <li key={i} className={`alert--${a.level}`} onClick={() => navigate(`/${a.business}${a.link}`)}>
                    <strong>{a.title} <BizTag id={a.business} /></strong><span>{a.detail}</span>
                  </li>
                ))}
              </ul>
              {alerts.length > 5 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAllAlerts(!allAlerts)}>{allAlerts ? 'Show fewer' : `Show all ${alerts.length}`}</button>}
            </>
          )}
        </div>
        <div className="panel">
          <div className="panel__header"><div><p>Right now</p><h2>Money position</h2></div></div>
          <div className="kv">
            {methods.map((m) => <Fragment key={m}><span>{m} held</span><span>{money(heldBy(m))}</span></Fragment>)}
            <span className="kv-total">Money held in total</span><span className="kv-total">{money(held)}</span>
            <span>Customers owe you</span><span>{money(owed)}</span>
            <span>You owe suppliers</span><span>{money(weOwe)}</span>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Money held is what the records show across the businesses.</p>
        </div>
      </div>
    </div>
  );
}

// ── Reports ─────────────────────────────────────────────────────
export function OwnerReports() {
  const { businesses, businessName, today } = useAuth();
  const [tab, setTab] = useState('summary');
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const r = useLoad(() => (tab === 'summary' ? get('/reports/summary', { business: 'all', from, to }) : Promise.resolve(null)), [from, to, tab === 'summary']);
  const s = r.data;

  // Per day: sales of each business, total sales, profit.
  const days: any[] = s ? Object.values((s.daily as any[]).reduce((acc: Record<string, any>, x: any) => {
    const d = acc[x.entry_date] ?? (acc[x.entry_date] = { date: x.entry_date, by: {} as Record<string, number>, sales: 0, profit: 0 });
    d.by[x.business_id] = (d.by[x.business_id] ?? 0) + x.revenue; d.sales += x.revenue; d.profit += x.profit;
    return acc;
  }, {})).sort((a: any, b: any) => (a.date < b.date ? 1 : -1)) : [];
  const maxDay = Math.max(1, ...days.map((d) => d.sales));
  // Where the money went: expenses by what they were for, all businesses together.
  const spend: [string, number][] = s ? (Object.entries((s.expenses as any[]).reduce((m: Record<string, number>, e: any) => ({ ...m, [e.category]: (m[e.category] ?? 0) + e.total }), {})) as [string, number][]).sort((a, b) => b[1] - a[1]) : [];
  const spendTotal = spend.reduce((t, [, v]) => t + v, 0);
  // How customers paid.
  const paid: [string, number][] = s ? Object.entries((s.methods as any[]).reduce((m: Record<string, number>, x: any) => ({ ...m, [x.method_name]: (m[x.method_name] ?? 0) + x.total }), {})) as [string, number][] : [];
  const credit = s ? { given: sum(s.credit, 'given'), collected: sum(s.credit, 'collected') } : { given: 0, collected: 0 };
  const all: Pnl = s?.profit.all ?? { revenue: 0, profit: 0 };

  return (
    <div className="module-page">
      <PageHeader icon={<BarChart3 size={22} />} title="Reports" subtitle="All businesses together"
        actions={tab === 'summary' ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button> : undefined} />
      <div className="panel" style={{ paddingBottom: 0 }}><Tabs tabs={[{ key: 'summary', label: 'Summary' }, { key: 'transactions', label: 'All transactions' }]} activeTab={tab} onTabChange={setTab} /></div>
      {tab === 'transactions' && <div className="panel"><Ledger scope="all" /></div>}
      {tab === 'summary' && (
        <>
          <div className="no-print"><DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} /></div>
          <ErrorBox error={r.error} />
          {s && (
            <div className="print-area form-stack">
              <img className="print-only print-logo" src="/logo-full.svg" alt="Meecaad" />
              <h3 className="print-only">Meecaad — all businesses — {s.from} to {s.to}</h3>

              <div className="panel">
                <div className="panel__header"><div><p>{s.from} to {s.to}</p><h2>By business</h2></div></div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Business</th><th className="num">Sales</th><th className="num">Spent</th><th className="num">Profit</th><th className="num">Share of sales</th></tr></thead>
                    <tbody>
                      {businesses.map((b) => {
                        const t: Pnl = s.profit[b.id];
                        return (
                          <tr key={b.id}><td><strong>{businessName(b.id)}</strong></td><td className="num">{money(t.revenue)}</td><td className="num">{money(spent(t))}</td>
                            <td className="num" style={{ color: t.profit < 0 ? '#b91c1c' : '#15803d', fontWeight: 700 }}>{money(t.profit)}</td>
                            <td className="num">{all.revenue ? `${Math.round((t.revenue / all.revenue) * 100)}%` : '—'}</td></tr>
                        );
                      })}
                      <tr><td><strong>All together</strong></td><td className="num"><strong>{money(all.revenue)}</strong></td><td className="num"><strong>{money(spent(all))}</strong></td>
                        <td className="num" style={{ color: all.profit < 0 ? '#b91c1c' : '#15803d', fontWeight: 800 }}>{money(all.profit)}</td><td></td></tr>
                    </tbody>
                  </table>
                </div>
                <p className="small muted" style={{ marginTop: 8 }}>Spent = cost of goods + expenses + losses and cash shortages. Profit = Sales − Spent.</p>
              </div>

              <div className="grid-2">
                <div className="panel">
                  <div className="panel__header"><div><p>Expenses</p><h2>Where the money went</h2></div></div>
                  <div className="form-stack">
                    {spend.slice(0, 8).map(([cat, v]) => (
                      <div key={cat}><div className="row row--between small"><span>{cat}</span><span><strong>{money(v)}</strong>{spendTotal ? ` · ${Math.round((v / spendTotal) * 100)}%` : ''}</span></div><div className="bar"><span style={{ width: `${Math.max(2, Math.round((v / (spend[0][1] || 1)) * 100))}%`, background: '#f59e0b' }} /></div></div>
                    ))}
                    {spend.length > 8 && <span className="small muted">+ {spend.length - 8} smaller {spend.length - 8 === 1 ? 'item' : 'items'}: {money(spend.slice(8).reduce((t, [, v]) => t + v, 0))}</span>}
                    {!spend.length && <span className="muted">No expenses in this period.</span>}
                  </div>
                </div>
                <div className="panel">
                  <div className="panel__header"><div><p>Sales</p><h2>How customers paid</h2></div></div>
                  <div className="kv">
                    {paid.map(([m, v]) => <Fragment key={m}><span>{m}</span><span>{money(v)}</span></Fragment>)}
                    <span>Given on credit</span><span>{money(credit.given)}</span>
                    <span>Credit paid back</span><span>{money(credit.collected)}</span>
                  </div>
                  {!paid.length && <span className="muted">No sales in this period.</span>}
                </div>
              </div>

              <div className="panel">
                <div className="panel__header"><div><p>Sales</p><h2>Day by day</h2></div></div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Date</th>{businesses.map((b) => <th key={b.id} className="num">{businessName(b.id)}</th>)}<th>All sales</th><th className="num">Profit</th></tr></thead>
                    <tbody>
                      {days.map((x) => (
                        <tr key={x.date}><td>{x.date}</td>{businesses.map((b) => <td key={b.id} className="num">{x.by[b.id] ? money(x.by[b.id]) : <span className="muted">—</span>}</td>)}
                          <td style={{ minWidth: 140 }}><strong>{money(x.sales)}</strong><div className="bar"><span style={{ width: `${Math.max(2, Math.round((x.sales / maxDay) * 100))}%`, background: 'var(--primary)' }} /></div></td>
                          <td className="num" style={{ color: x.profit < 0 ? '#b91c1c' : undefined }}>{money(x.profit)}</td></tr>
                      ))}
                      {!days.length && <tr><td colSpan={businesses.length + 3} className="muted">No sales in this period.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
