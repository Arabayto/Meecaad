import { useState } from 'react';
import { Printer, TrendingUp } from 'lucide-react';
import { get, money, num } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { ErrorBox, Kpi, PageHeader, addDays, useLoad } from '../components/ui';

type Period = 'today' | 'week' | 'month' | 'year' | 'custom';
const LABEL: Record<Period, string> = { today: 'Today', week: 'This week', month: 'This month', year: 'This year', custom: 'Custom' };

function bounds(p: Period, today: string): [string, string] {
  if (p === 'today') return [today, today];
  if (p === 'week') return [addDays(today, -((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7)), today];
  if (p === 'month') return [today.slice(0, 8) + '01', today];
  if (p === 'year') return [today.slice(0, 5) + '01-01', today];
  return [today, today];
}

/**
 * Profit tracking for the business of this portal only (store, restaurant or fuel station):
 * sales, cost of goods, expenses, losses and net profit for a period, compared with the period
 * before; the items that bring the profit; and profit day by day.
 */
export function ProfitTrackingPage() {
  const { business, businessName, today } = useAuth();
  const [period, setPeriod] = useState<Period>('today');
  const [custom, setCustom] = useState<[string, string]>([addDays(today, -6), today]);
  const [from, to] = period === 'custom' ? custom : bounds(period, today);
  const data = useLoad(() => get('/tracking/profit', { business, from, to }), [business, from, to]);
  const d = data.data;
  const t = d?.totals, p = d?.previous;
  const status = !t ? '' : t.profit > 0 ? 'Profitable' : t.profit < 0 ? 'Losing money' : 'Break-even';
  const losses = t ? t.losses + t.cashDiff : 0;
  const maxDay = Math.max(1, ...(d?.daily ?? []).map((x: any) => Math.max(x.revenue, Math.abs(x.profit))));
  const maxItem = Math.max(1, ...(d?.top ?? []).map((x: any) => x.revenue));
  const restaurant = business === 'restaurant';

  return (
    <div className="module-page">
      <PageHeader icon={<TrendingUp size={22} />} title={`Profit tracking — ${businessName(business)}`}
        subtitle={d ? `${from === to ? from : `${from} to ${to}`} · compared with ${p.from === p.to ? p.from : `${p.from} to ${p.to}`}` : 'Only this business'}
        actions={<button type="button" className="btn btn-secondary no-print" onClick={() => window.print()}><Printer size={16} /> Print</button>} />

      <div className="panel no-print">
        <div className="row" style={{ gap: 6 }}>
          <div className="scope-tabs">
            {(Object.keys(LABEL) as Period[]).map((k) => <button key={k} type="button" className={period === k ? 'active' : ''} onClick={() => setPeriod(k)}>{LABEL[k]}</button>)}
          </div>
          {period === 'custom' && (
            <div className="toolbar">
              <input type="date" className="form-input date-input" value={custom[0]} max={custom[1]} onChange={(e) => setCustom([e.target.value, custom[1]])} aria-label="From" />
              <span>to</span>
              <input type="date" className="form-input date-input" value={custom[1]} min={custom[0]} max={today} onChange={(e) => setCustom([custom[0], e.target.value])} aria-label="To" />
            </div>
          )}
        </div>
      </div>
      <ErrorBox error={data.error} />

      {t && (
        <>
          <div className="kpi-grid">
            <Kpi label="Sales" value={money(t.revenue)} now={t.revenue} before={p.revenue} sub={`${num(t.sales)} sale${t.sales === 1 ? '' : 's'} · average ${money(t.average)}`} />
            {!restaurant && <Kpi label="Cost of goods" value={money(t.cogs)} now={t.cogs} before={p.cogs} lowerIsBetter sub={`gross profit ${money(t.grossProfit)}`} />}
            <Kpi label="Expenses" value={money(t.expenses)} now={t.expenses} before={p.expenses} lowerIsBetter sub={t.revenue ? `${Math.round((t.expenses / t.revenue) * 100)}% of sales` : 'operating costs'} />
            <Kpi label="Losses" value={money(losses)} now={losses} before={p.losses + p.cashDiff} lowerIsBetter tone={losses > 0 ? 'red' : undefined}
              sub={restaurant ? 'cash short at closings' : 'stock lost + cash short'} />
            <Kpi label="Net profit" value={money(t.profit)} now={t.profit} before={p.profit} tone={t.profit < 0 ? 'red' : t.profit > 0 ? 'green' : undefined} sub={status} />
            <Kpi label="Profit margin" value={`${t.margin}%`} sub={t.revenue ? `of every $1 sold, ${money(Math.round(t.margin))} is profit` : 'no sales'} />
          </div>

          <div className="panel">
            <div className="panel__header"><div><p>How it adds up</p><h2>Profit</h2></div></div>
            <div className="kv" style={{ fontSize: 14 }}>
              <span>Sales</span><span>{money(t.revenue)}</span>
              {!restaurant && <><span>− Cost of the goods sold</span><span>{money(t.cogs)}</span></>}
              {!restaurant && <><span className="kv-total">= Gross profit</span><span className="kv-total">{money(t.grossProfit)}</span></>}
              <span>− Expenses</span><span>{money(t.expenses)}</span>
              {!restaurant && <><span>− Stock lost (waste, damage, counts)</span><span>{money(t.losses)}</span></>}
              <span>− Cash short at closing (+ over)</span><span>{money(t.cashDiff)}</span>
              <span className="kv-total">= Net profit</span><span className="kv-total" style={{ color: t.profit < 0 ? '#b91c1c' : '#15803d' }}>{money(t.profit)}</span>
            </div>
            {t.belowCost > 0 && <div className="mc-warn" style={{ marginTop: 10 }}>Some items were sold below their cost price: {money(t.belowCost)} less than they cost. See the items marked below.</div>}
          </div>

          <div className="panel">
            <div className="panel__header"><div><p>{restaurant ? 'What sells the most' : 'What brings the profit'}</p><h2>{restaurant ? 'Top items' : 'Top profitable items'}</h2></div></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Item</th><th className="num">Sold</th><th>Sales</th>{!restaurant && <><th className="num">Cost</th><th className="num">Profit</th><th className="num">Margin</th></>}</tr></thead>
                <tbody>
                  {d.top.map((i: any) => (
                    <tr key={i.id || i.name}>
                      <td><strong>{i.name}</strong><div className="small muted">in {num(i.sales)} sale{i.sales === 1 ? '' : 's'}</div>
                        {i.below_cost > 0 && <div className="small pos-out">sold {money(i.below_cost)} below cost</div>}</td>
                      <td className="num">{num(i.qty)}</td>
                      <td style={{ minWidth: 140 }}>{money(i.revenue)}<div className="bar"><span style={{ width: `${(i.revenue / maxItem) * 100}%`, background: '#f59e0b' }} /></div></td>
                      {!restaurant && <><td className="num">{money(i.cost)}</td><td className="num" style={{ color: i.profit < 0 ? '#b91c1c' : '#15803d' }}>{money(i.profit)}</td><td className="num">{i.margin}%</td></>}
                    </tr>
                  ))}
                  {!d.top.length && <tr><td colSpan={6} className="muted">Nothing sold in this period.</td></tr>}
                </tbody>
              </table>
            </div>
            {d.weakest.length > 0 && d.weakest[0].margin < 10 && (
              <p className="small muted" style={{ marginBottom: 0 }}>Lowest margin: {d.weakest.filter((w: any) => w.margin < 10).map((w: any) => `${w.name} (${w.margin}%)`).join(', ')} — check their prices.</p>
            )}
          </div>

          <div className="grid-2">
            <div className="panel">
              <div className="panel__header"><div><p>Trend</p><h2>Profit day by day</h2></div></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Day</th><th>Sales</th>{!restaurant && <th className="num">Cost</th>}<th className="num">Expenses & losses</th><th className="num">Profit</th></tr></thead>
                  <tbody>
                    {[...d.daily].reverse().map((x: any) => (
                      <tr key={x.date}>
                        <td className="small">{x.date}</td>
                        <td style={{ minWidth: 100 }}>{money(x.revenue)}<div className="bar"><span style={{ width: `${(x.revenue / maxDay) * 100}%`, background: 'var(--primary)' }} /></div></td>
                        {!restaurant && <td className="num">{money(x.cogs)}</td>}
                        <td className="num">{money(x.expenses + x.losses + x.cashDiff)}</td>
                        <td className="num"><strong style={{ color: x.profit < 0 ? '#b91c1c' : '#15803d' }}>{money(x.profit)}</strong></td>
                      </tr>
                    ))}
                    {!d.daily.length && <tr><td colSpan={5} className="muted">No activity in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="panel">
              <div className="panel__header"><div><p>Costs</p><h2>Where the money went</h2></div></div>
              {d.expenses.map((e: any) => (
                <div key={e.category} style={{ marginBottom: 10 }}>
                  <div className="row row--between small"><span>{e.category}</span><strong>{money(e.total)}{t.expenses ? ` · ${Math.round((e.total / t.expenses) * 100)}%` : ''}</strong></div>
                  <div className="bar"><span style={{ width: `${t.expenses ? (e.total / t.expenses) * 100 : 0}%`, background: '#ef4444' }} /></div>
                </div>
              ))}
              {d.losses.map((l: any) => (
                <div key={l.account + l.category} className="row row--between small" style={{ marginBottom: 6 }}>
                  <span>{l.account === 'cash_diff' ? `Cash ${l.total > 0 ? 'short' : 'over'} (${l.category})` : `Stock lost (${l.category})`}</span><strong>{money(l.total)}</strong>
                </div>
              ))}
              {!d.expenses.length && !d.losses.length && <p className="muted">No expenses or losses in this period.</p>}
            </div>
          </div>
        </>
      )}
      {!t && data.loading && <div className="panel muted">Loading…</div>}
    </div>
  );
}
