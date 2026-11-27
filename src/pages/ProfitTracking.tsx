import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Award, BarChart2, CreditCard, DollarSign, Percent, ShoppingCart, TrendingDown, TrendingUp } from 'lucide-react';
import { get, money, num } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { addDays, useLoad } from '../components/ui';
import '../styles/pharma.css';

type Period = 'today' | 'week' | 'month' | 'year' | 'custom';
const LABEL: Record<Period, string> = { today: 'Today', week: 'Week', month: 'Month', year: 'Year', custom: 'Custom' };

function bounds(p: Period, today: string): [string, string] {
  if (p === 'today') return [today, today];
  if (p === 'week') return [addDays(today, -((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7)), today];
  if (p === 'month') return [today.slice(0, 8) + '01', today];
  if (p === 'year') return [today.slice(0, 5) + '01-01', today];
  return [today, today];
}
const label = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

/**
 * Profit Tracking — the pharmacy's page, for the business of this portal only (store, restaurant
 * or fuel station): coloured cards, the profit trend and the top profitable items.
 */
export function ProfitTrackingPage() {
  const { business, today } = useAuth();
  const [period, setPeriod] = useState<Period>('today');
  const [draft, setDraft] = useState<[string, string]>([addDays(today, -6), today]);
  const [custom, setCustom] = useState<[string, string]>([addDays(today, -6), today]);
  const [rangeError, setRangeError] = useState('');
  const [from, to] = period === 'custom' ? custom : bounds(period, today);
  const data = useLoad(() => get('/tracking/profit', { business, from, to }), [business, from, to]);
  const d = data.data;
  const t = d?.totals;
  const losses = t ? t.losses + t.cashDiff : 0;
  const profitTone = !t ? 'even' : t.profit > 0 ? 'profit' : t.profit < 0 ? 'loss' : 'even';
  const apply = () => {
    if (!draft[0] || !draft[1]) { setRangeError('Please select both start and end dates'); return; }
    if (draft[0] > draft[1]) { setRangeError('Start date must be before end date'); return; }
    setRangeError(''); setCustom(draft);
  };

  return (
    <div className="module-page ph">
      <div className="ph-head-row">
        <h2 className="ph-title"><TrendingUp size={26} /> Profit Tracking</h2>
        <div className="ph-btn-group" role="group" aria-label="Period">
          {(Object.keys(LABEL) as Period[]).map((k) => (
            <button key={k} type="button" className={period === k ? 'active' : ''} onClick={() => setPeriod(k)}>{LABEL[k]}</button>
          ))}
        </div>
      </div>

      {period === 'custom' && (
        <div className="ph-card">
          <div className="ph-card__body">
            <div className="ph-range">
              <div><label className="ph-label" htmlFor="pt-s" style={{ color: '#212529' }}>Start Date</label>
                <input id="pt-s" type="date" className="ph-input" value={draft[0]} max={today} onChange={(e) => setDraft([e.target.value, draft[1]])} /></div>
              <div><label className="ph-label" htmlFor="pt-e" style={{ color: '#212529' }}>End Date</label>
                <input id="pt-e" type="date" className="ph-input" value={draft[1]} max={today} onChange={(e) => setDraft([draft[0], e.target.value])} /></div>
              <div><button type="button" className="ph-btn ph-btn--primary" onClick={apply}>Apply Range</button></div>
            </div>
            {rangeError && <div className="ph-alert ph-alert--danger" style={{ marginTop: 12 }}>{rangeError}</div>}
          </div>
        </div>
      )}

      {data.error && <div className="ph-alert ph-alert--danger">Error loading profit data. Please try again.</div>}
      {!t && data.loading && <div className="ph-empty">Loading…</div>}

      {t && (
        <>
          <div className="ph-metrics">
            <Metric tone="revenue" icon={<DollarSign />} title="Total Revenue" value={money(t.revenue)} sub={`${num(t.sales)} sale${t.sales === 1 ? '' : 's'}`} />
            <Metric tone="cost" icon={<ShoppingCart />} title="Total Cost" value={money(t.cogs)} sub={d.hasCost ? `${num(t.qty)} items` : 'menu items have no cost price'} />
            <Metric tone="expenses" icon={<CreditCard />} title="Expenses" value={money(t.expenses)} sub="Operating expenses" />
            <Metric tone={profitTone} icon={t.profit < 0 ? <TrendingDown /> : <TrendingUp />} title="Net Profit" value={money(t.profit)}
              sub={t.profit > 0 ? 'Profitable' : t.profit < 0 ? 'Loss' : 'Break-even'} />
            <Metric tone="margin" icon={<Percent />} title="Profit Margin" value={`${t.margin}%`} sub="Industry avg: 20-25%" />
            {losses !== 0 && <Metric tone="losses" icon={<AlertTriangle />} title="Losses" value={money(losses)}
              sub={[t.losses ? `stock lost ${money(t.losses)}` : '', t.cashDiff ? `cash ${t.cashDiff > 0 ? 'short' : 'over'} ${money(Math.abs(t.cashDiff))}` : ''].filter(Boolean).join(' · ')} />}
          </div>

          <div className="ph-charts">
            <div className="ph-card">
              <div className="ph-card__head"><h5><BarChart2 /> {d.trend.length === 7 ? '7-Day' : `${d.trend.length}-Day`} Profit Trend</h5></div>
              <div className="ph-card__body"><TrendChart days={d.trend} /></div>
            </div>
            <div className="ph-card">
              <div className="ph-card__head"><h5><Award /> Top Profitable Items</h5></div>
              <div className="ph-card__body">
                {!d.top.length && <div className="ph-muted" style={{ textAlign: 'center', padding: '12px 0' }}>No sales data available</div>}
                {d.top.slice(0, 5).map((m: any) => {
                  const marginTone = m.margin >= 25 ? 't-success' : m.margin >= 15 ? 't-warning' : 't-danger';
                  return (
                    <div key={m.id || m.name} className="ph-list-item">
                      <div style={{ minWidth: 0 }}>
                        <h6>{m.name}</h6>
                        <small className="ph-muted">{num(m.qty)} units sold</small>
                        {m.below_cost > 0 && <small className="t-danger" style={{ display: 'block' }}>Loss: {money(m.below_cost)}</small>}
                      </div>
                      <div className="right">
                        <strong className={m.profit >= 0 ? 't-success' : 't-danger'}>{money(m.profit)}</strong>
                        <small className={marginTone}>{m.margin}% margin</small>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ tone, icon, title, value, sub }: { tone: string; icon: JSX.Element; title: string; value: string; sub: string }) {
  return (
    <div className={`ph-metric ph-metric--${tone}`}>
      <div className="ph-metric__icon">{icon}</div>
      <h6 className="ph-metric__title">{title}</h6>
      <h3 className="ph-metric__value">{value}</h3>
      <small className="ph-metric__sub">{sub}</small>
    </div>
  );
}

/** Revenue, cost, losses (dashed) and profit (filled) per day — the pharmacy's chart (Chart.js). */
function TrendChart({ days }: { days: any[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let chart: any;
    let gone = false;
    import('chart.js').then(({ Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Legend, Tooltip }) => {
      if (gone || !canvas.current) return;
      Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Legend, Tooltip);
      const usd = (c: number) => Math.round(c) / 100;
      chart = new Chart(canvas.current, {
        type: 'line',
        data: {
          labels: days.map((x) => label(x.date)),
          datasets: [
            { label: 'Revenue', data: days.map((x) => usd(x.revenue)), borderColor: 'rgb(54,162,235)', backgroundColor: 'rgba(54,162,235,0.1)', tension: 0.4 },
            { label: 'Cost', data: days.map((x) => usd(x.cogs)), borderColor: 'rgb(255,193,7)', backgroundColor: 'rgba(255,193,7,0.1)', tension: 0.4 },
            { label: 'Losses', data: days.map((x) => usd(x.losses + x.cashDiff)), borderColor: 'rgb(220,53,69)', backgroundColor: 'rgba(220,53,69,0.1)', tension: 0.4, borderDash: [5, 5] },
            { label: 'Profit', data: days.map((x) => usd(x.profit)), borderColor: 'rgb(40,167,69)', backgroundColor: 'rgba(40,167,69,0.1)', tension: 0.4, fill: true },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: { y: { beginAtZero: true, ticks: { callback: (v: any) => '$' + Number(v).toLocaleString() } } },
          plugins: { tooltip: { callbacks: { label: (c: any) => `${c.dataset.label}: ${money(Math.round(c.parsed.y * 100))}` } } },
        },
      });
    });
    return () => { gone = true; chart?.destroy(); };
  }, [days]);
  return <div className="ph-chart"><canvas ref={canvas} role="img" aria-label="Profit trend chart" /></div>;
}
