// Fuel station, kept simple: Sales (record the fuel sold and how the money was
// received), Dashboard, Reports (daily reconciliation) and Settings (daily
// USD → Somaliland Shilling rate, prices, pumps and the rest).
import { Fragment, useState } from 'react';
import { BarChart3, CheckCircle2, Fuel, Home, Printer, RefreshCw, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { fromCents, get, money, num, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { Tabs } from '../components/Tabs';
import { PageSkeleton } from '../components/LoadingSpinner';
import { DateRange, ErrorBox, Field, Money, MoneyInput, PageHeader, PartySelect, ReasonModal, Stat, addDays, fmtTime, useLoad, useSubmit } from '../components/ui';
import { Dips, Reconciliation, Setup } from './FuelPage';
import { StockPage } from './StockPage';
import { PurchasesPage } from './PurchasesPage';
import { ExpensesPage } from './ExpensesPage';
import { PartiesPage } from './PartiesPage';

const F = 'fuel';

/** "14,280,000 SLSH" for an amount in cents at a rate (SLSH per $1), or null when there is no rate. */
export const slsh = (cents: number, rate: number | null | undefined) => (rate ? `${Math.round((cents / 100) * rate).toLocaleString('en-US')} SLSH` : null);
const rateText = (rate: number) => `$1 = ${rate.toLocaleString('en-US')} SLSH`;

/** Settled / Outstanding / Over, from "outstanding" = sales − received − debts (cents). */
function Settlement({ outstanding }: { outstanding: number }) {
  if (outstanding === 0) return <StatusBadge label="Settled" tone="green" />;
  return outstanding > 0 ? <StatusBadge label={`Outstanding ${money(outstanding)}`} tone="yellow" /> : <StatusBadge label={`Over ${money(-outstanding)}`} tone="red" />;
}

function RateBanner({ rates }: { rates: { data: any } }) {
  const { can, path } = useAuth();
  const navigate = useNavigate();
  const d = rates.data;
  if (!d) return null;
  if (!d.current) return (
    <div className="mc-warn">No exchange rate yet. {can('catalog')
      ? <button type="button" className="btn btn-ghost btn-xs" onClick={() => navigate(path('/settings'))}>Set the USD → SLSH rate</button> : 'Ask the manager to set it.'}</div>
  );
  if (!d.setToday) return (
    <div className="mc-warn">Today's rate is not set yet — using {rateText(d.current.rate)} from {d.current.rate_date}. {can('catalog')
      && <button type="button" className="btn btn-ghost btn-xs" onClick={() => navigate(path('/settings'))}>Update today's rate</button>}</div>
  );
  return null;
}

// ── Sales ────────────────────────────────────────────────────────
export function FuelSalesPage() {
  const { today, can, activeMethods } = useAuth();
  const setup = useLoad(() => get('/fuel/setup'), []);
  const rates = useLoad(() => get('/rates'), []);
  const customers = useLoad(() => get('/customers', { business: F }), []);
  const recent = useLoad(() => get('/fuel/shifts', { from: addDays(today, -6), to: today }), [today]);
  const rate: number | null = rates.data?.current?.rate ?? null;

  const pumps = (setup.data?.pumps ?? []).filter((p: any) => p.active);
  const [date, setDate] = useState(today);
  const [opening, setOpening] = useState<Record<string, string>>({});
  const [closing, setClosing] = useState<Record<string, string>>({});
  const [amt, setAmt] = useState<Record<string, string>>({});
  const [cashIn, setCashIn] = useState<'USD' | 'SLSH'>('USD');
  const [debts, setDebts] = useState<{ customer: string; amount: string }[]>([]);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState<any>(null);
  const { run, busy } = useSubmit();

  const rows = pumps.map((p: any) => {
    const o = opening[p.id] === undefined || opening[p.id] === '' ? p.last_meter : Number(opening[p.id]);
    const c = closing[p.id] === undefined || closing[p.id] === '' ? null : Number(closing[p.id]);
    const liters = c === null ? 0 : Math.round((c - o) * 1000) / 1000;
    return { p, o, c, liters, amount: Math.round(Math.max(liters, 0) * p.sale_price), bad: c !== null && c < o, gap: Math.abs(o - p.last_meter) > 0.0005 };
  });
  const entered = rows.filter((r: any) => r.c !== null);
  const due = entered.reduce((s: number, r: any) => s + r.amount, 0);
  const liters = entered.reduce((s: number, r: any) => s + r.liters, 0);
  const usd = (id: string) => {
    const v = amt[id];
    if (!v) return 0;
    return id === 'cash' && cashIn === 'SLSH' && rate ? Math.round((Number(v) / rate) * 100) : toCents(v);
  };
  const received = activeMethods.reduce((s, m) => s + usd(m.id), 0);
  const owed = debts.reduce((s, d) => s + toCents(d.amount), 0);
  const remaining = due - received - owed;
  const fillRest = () => {
    const cash = usd('cash') + remaining;
    setAmt({ ...amt, cash: cashIn === 'SLSH' && rate ? String(Math.round((cash / 100) * rate)) : fromCents(cash) });
  };

  const save = async () => {
    const r = await run((key) => post('/fuel/shifts', {
      date, shiftName: 'Day', differenceReason: note, note: '',
      readings: entered.map((r: any) => ({ pump: r.p.id, opening: r.o, closing: r.c })),
      payments: activeMethods.map((m) => ({ method: m.id, amount: usd(m.id) })).filter((p) => p.amount > 0),
      credits: debts.map((d) => ({ customer: d.customer, amount: toCents(d.amount) })).filter((d) => d.amount > 0),
    }, key), remaining > 0 ? `Saved — ${money(remaining)} still outstanding` : 'Sales saved');
    if (r) { setClosing({}); setOpening({}); setAmt({}); setDebts([]); setNote(''); setup.reload(); recent.reload(); }
  };

  const status = !entered.length ? null : remaining === 0 ? 'ok' : remaining > 0 ? 'outstanding' : 'over';
  const canSave = !busy && entered.length > 0 && !entered.some((r: any) => r.bad) && !debts.some((d) => !d.customer && toCents(d.amount) > 0) && (remaining <= 0 ? (remaining === 0 || note.trim() !== '') : true);

  return (
    <div className="module-page">
      <PageHeader icon={<Fuel size={22} />} title="Sales" subtitle={rate ? `Fuel sold and how the money came in · ${rateText(rate)}` : 'Fuel sold and how the money came in'} />
      <RateBanner rates={rates} />
      <ErrorBox error={setup.error} />
      {can('fuel') && (
        <>
          <div className="panel form-stack">
            <div className="panel__header">
              <div><p>Step 1</p><h2>Fuel sold</h2></div>
              <input type="date" className="form-input date-input" value={date} max={today} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
            </div>
            {!pumps.length && !setup.loading ? <div className="mc-note">No pumps yet. The manager adds them in Settings → Pumps &amp; tanks.</div> : (
              <div className="table-wrap lines-table">
                <table>
                  <thead><tr><th>Pump</th><th>Opening meter</th><th>Closing meter</th><th className="num">Litres</th><th className="num">Price</th><th className="num">Sales</th></tr></thead>
                  <tbody>
                    {rows.map((r: any) => (
                      <tr key={r.p.id}>
                        <td><strong>{r.p.name}</strong><div className="small muted">{r.p.fuel_name}</div></td>
                        <td><input className="form-input" inputMode="decimal" style={{ minWidth: 110 }} value={opening[r.p.id] ?? String(r.p.last_meter)} onChange={(e) => setOpening({ ...opening, [r.p.id]: e.target.value })} aria-label={`${r.p.name} opening meter`} />
                          {r.gap && <div className="small" style={{ color: '#b91c1c' }}>Last closing was {num(r.p.last_meter)}</div>}</td>
                        <td><input className="form-input" inputMode="decimal" style={{ minWidth: 110 }} value={closing[r.p.id] ?? ''} onChange={(e) => setClosing({ ...closing, [r.p.id]: e.target.value })} placeholder="Read the meter" aria-label={`${r.p.name} closing meter`} />
                          {r.bad && <div className="small" style={{ color: '#b91c1c' }}>Lower than opening</div>}</td>
                        <td className="num">{r.c !== null ? num(r.liters) : '—'}</td>
                        <td className="num">{money(r.p.sale_price)}</td>
                        <td className="num">{r.c !== null ? money(r.amount) : '—'}</td>
                      </tr>
                    ))}
                    <tr><td colSpan={3}><strong>Total to account for</strong></td><td className="num"><strong>{num(liters)} L</strong></td><td></td>
                      <td className="num"><strong>{money(due)}</strong>{slsh(due, rate) && <div className="small muted">{slsh(due, rate)}</div>}</td></tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel form-stack">
            <div className="panel__header"><div><p>Step 2</p><h2>How it was received</h2></div></div>
            <div className="table-wrap lines-table">
              <table>
                <tbody>
                  {activeMethods.map((m) => (
                    <tr key={m.id}>
                      <td style={{ width: 120 }}><strong>{m.name}</strong></td>
                      <td style={{ minWidth: 160 }}>
                        <MoneyInput value={amt[m.id] ?? ''} onChange={(v) => setAmt({ ...amt, [m.id]: v })} placeholder={m.id === 'cash' && cashIn === 'SLSH' ? '0' : '0.00'} />
                      </td>
                      <td className="small muted">
                        {m.id === 'cash' && rate ? (
                          <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                            <button type="button" className={`btn btn-xs ${cashIn === 'USD' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setCashIn('USD'); setAmt({ ...amt, cash: '' }); }}>USD</button>
                            <button type="button" className={`btn btn-xs ${cashIn === 'SLSH' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setCashIn('SLSH'); setAmt({ ...amt, cash: '' }); }}>SLSH</button>
                            {cashIn === 'SLSH' && usd('cash') > 0 && <span>= {money(usd('cash'))}</span>}
                          </span>
                        ) : usd(m.id) > 0 && slsh(usd(m.id), rate)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{ verticalAlign: 'top' }}><strong>Customer debts</strong><div className="small muted">unpaid sales</div></td>
                    <td colSpan={2}>
                      <div className="pay-lines">
                        {debts.map((d, i) => (
                          <div className="pay-line" key={i}>
                            <PartySelect kind="customers" value={d.customer} items={customers.data ?? []} placeholder="Choose customer…" onCreated={customers.reload}
                              onChange={(v) => setDebts(debts.map((x, j) => (j === i ? { ...x, customer: v } : x)))} />
                            <MoneyInput value={d.amount} onChange={(v) => setDebts(debts.map((x, j) => (j === i ? { ...x, amount: v } : x)))} />
                            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setDebts(debts.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
                          </div>
                        ))}
                        <div><button type="button" className="btn btn-ghost btn-xs" onClick={() => setDebts([...debts, { customer: '', amount: '' }])}>+ Add customer debt</button></div>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <section className="stat-grid">
              <Stat label="To account for" value={money(due)} sub={slsh(due, rate) ?? undefined} />
              <Stat label="Received + debts" value={money(received + owed)} sub={`Received ${money(received)} · debts ${money(owed)}`} />
              <Stat label={status === 'over' ? 'Over' : 'Remaining'} value={money(Math.abs(remaining))} tone={status === 'ok' ? 'green' : status === 'over' ? 'red' : undefined}
                sub={status === 'ok' ? 'Fully accounted for' : slsh(Math.abs(remaining), rate) ?? undefined} />
            </section>
            {status === 'ok' && <div className="mc-note"><CheckCircle2 size={14} style={{ verticalAlign: -2 }} /> Fully accounted for: {money(due)}.</div>}
            {status === 'outstanding' && (
              <div className="mc-warn">{money(remaining)} is not accounted for yet. You can save now; it stays <strong>outstanding</strong> until it is received.{' '}
                <button type="button" className="btn btn-ghost btn-xs" onClick={fillRest}>Put the rest in Cash</button></div>
            )}
            {status === 'over' && <div className="mc-error">More money than sales by {money(-remaining)}. Explain why below.</div>}
            {status && status !== 'ok' && (
              <Field label={status === 'over' ? 'Explain (required)' : 'Note (optional)'}>
                <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={status === 'over' ? 'e.g. old debt paid' : 'e.g. attendant will bring the rest tomorrow'} />
              </Field>
            )}
            <div className="form-actions">
              <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>{status === 'outstanding' ? `Save · ${money(remaining)} outstanding` : 'Save sales'}</button>
            </div>
          </div>
        </>
      )}

      <div className="panel">
        <div className="panel__header"><div><p>Last 7 days</p><h2>Recorded sales</h2></div></div>
        <ErrorBox error={recent.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th className="num">Litres</th><th className="num">Sales</th><th className="num">Received</th><th className="num">Debts</th><th>Status</th><th>Recorded by</th></tr></thead>
            <tbody>
              {(recent.data ?? []).map((s: any) => (
                <tr key={s.id} className="tr--clickable" onClick={async () => setOpen(await get(`/fuel/shifts/${s.id}`))}>
                  <td className="small">{s.entry_date}<div className="muted">{fmtTime(s.created_at)}</div></td>
                  <td className="num">{num(s.total_liters)}</td><td className="num">{money(s.expected_amount)}</td>
                  <td className="num">{money(s.collected_amount)}</td><td className="num">{money(s.credit_amount)}</td>
                  <td>{s.status === 'voided' ? <StatusBadge label="Cancelled" tone="red" /> : <Settlement outstanding={-s.difference} />}{s.meter_gap_note && <div><StatusBadge label="Meter gap" tone="red" /></div>}</td>
                  <td className="small"><strong>{s.created_by_name}</strong></td>
                </tr>
              ))}
              {!recent.loading && !recent.data?.length && <tr><td colSpan={7} className="muted">Nothing recorded in the last 7 days.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {open && <EntryModal entry={open} rate={rate} customers={customers} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); recent.reload(); setup.reload(); }} />}
    </div>
  );
}

/** One recorded entry: litres per pump, how it was received, receive the outstanding rest, cancel. */
function EntryModal({ entry: e, rate, customers, onClose, onChanged }: { entry: any; rate: number | null; customers: { data: any; reload: () => void }; onClose: () => void; onChanged: () => void }) {
  const { can, activeMethods } = useAuth();
  const [voiding, setVoiding] = useState(false);
  const [paying, setPaying] = useState(false);
  const [amt, setAmt] = useState<Record<string, string>>({});
  const [debts, setDebts] = useState<{ customer: string; amount: string }[]>([]);
  const { run, busy } = useSubmit();
  const outstanding = -e.difference;
  const got = activeMethods.reduce((s, m) => s + toCents(amt[m.id] ?? ''), 0) + debts.reduce((s, d) => s + toCents(d.amount), 0);
  const settle = async () => {
    const r = await run((key) => post(`/fuel/shifts/${e.id}/settle`, {
      payments: activeMethods.map((m) => ({ method: m.id, amount: toCents(amt[m.id] ?? '') })).filter((p) => p.amount > 0),
      credits: debts.map((d) => ({ customer: d.customer, amount: toCents(d.amount) })).filter((d) => d.amount > 0),
    }, key), 'Payment recorded');
    if (r) onChanged();
  };
  return (
    <>
      <Modal open onClose={onClose} title={`Sales ${e.entry_date}`} width="lg"
        footer={<>
          {can('void') && e.status === 'completed' && <button type="button" className="btn btn-danger" onClick={() => setVoiding(true)}>Cancel entry</button>}
          <button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print</button>
        </>}>
        <div className="print-area form-stack">
          <img className="print-only print-logo" src="/logo-full.svg" alt="Meecaad" />
          <h3 className="print-only">Meecaad Fuel Station — sales {e.entry_date}</h3>
          {e.status === 'voided' && <div className="mc-error">Cancelled by {e.voided_by_name}: {e.void_reason}</div>}
          {e.meter_gap_note && <div className="mc-error">Meter gap: {e.meter_gap_note}</div>}
          <table>
            <thead><tr><th>Pump</th><th>Fuel</th><th className="num">Opening</th><th className="num">Closing</th><th className="num">Litres</th><th className="num">Price</th><th className="num">Sales</th></tr></thead>
            <tbody>{e.readings.map((r: any) => (
              <tr key={r.id}><td>{r.pump_name}</td><td>{r.fuel_name}</td><td className="num">{num(r.opening_meter)}</td><td className="num">{num(r.closing_meter)}</td>
                <td className="num">{num(r.liters)}</td><td className="num">{money(r.unit_price)}</td><td className="num">{money(r.amount)}</td></tr>
            ))}</tbody>
          </table>
          <div className="kv">
            <span>To account for</span><span>{money(e.expected_amount)}{slsh(e.expected_amount, rate) && <span className="small muted"> · {slsh(e.expected_amount, rate)}</span>}</span>
            {e.payments.map((p: any) => (
              <Fragment key={p.id}><span>{p.method_name ? `Received in ${p.method_name}` : `Debt: ${p.customer_name}`}{p.settled_at && <span className="small muted"> (later, {fmtTime(p.settled_at)})</span>}</span><span>{money(p.amount)}</span></Fragment>
            ))}
            <span className="kv-total">{outstanding > 0 ? 'Outstanding' : outstanding < 0 ? 'Over' : 'Remaining'}</span><span className="kv-total">{money(Math.abs(outstanding))}</span>
          </div>
          {e.difference_reason && <p className="small">Note: {e.difference_reason}</p>}
          <p className="small muted">Recorded by {e.created_by_name} at {fmtTime(e.created_at)}</p>
          {e.status === 'completed' && outstanding > 0 && can('fuel') && (
            <div className="no-print form-stack">
              {!paying ? <div><button type="button" className="btn btn-primary btn-sm" onClick={() => setPaying(true)}>Receive payment</button></div> : (
                <>
                  <h3 style={{ margin: 0 }}>Receive part of the {money(outstanding)} outstanding</h3>
                  <div className="form-row-3">
                    {activeMethods.map((m) => <Field key={m.id} label={m.name}><MoneyInput value={amt[m.id] ?? ''} onChange={(v) => setAmt({ ...amt, [m.id]: v })} /></Field>)}
                  </div>
                  <div className="pay-lines">
                    {debts.map((d, i) => (
                      <div className="pay-line" key={i}>
                        <PartySelect kind="customers" value={d.customer} items={customers.data ?? []} placeholder="Customer debt…" onCreated={customers.reload}
                          onChange={(v) => setDebts(debts.map((x, j) => (j === i ? { ...x, customer: v } : x)))} />
                        <MoneyInput value={d.amount} onChange={(v) => setDebts(debts.map((x, j) => (j === i ? { ...x, amount: v } : x)))} />
                        <button type="button" className="btn btn-ghost btn-xs" onClick={() => setDebts(debts.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
                      </div>
                    ))}
                    <div><button type="button" className="btn btn-ghost btn-xs" onClick={() => setDebts([...debts, { customer: '', amount: '' }])}>+ Add customer debt</button></div>
                  </div>
                  <div className="row row--between">
                    <span className="small">{got > outstanding ? <span style={{ color: '#b91c1c' }}>More than the outstanding amount</span> : `Remaining after this: ${money(outstanding - got)}`}</span>
                    <button type="button" className="btn btn-primary" disabled={busy || got <= 0 || got > outstanding || debts.some((d) => !d.customer && toCents(d.amount) > 0)} onClick={settle}>Save payment</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </Modal>
      <ReasonModal open={voiding} onClose={() => setVoiding(false)} title="Cancel these sales?" action={`/fuel/shifts/${e.id}/void`} confirmLabel="Cancel entry"
        message="The litres go back to the tank, the pump meters go back to their opening readings, and the money is reversed. Only the latest entry of a pump can be cancelled."
        onDone={onChanged} />
    </>
  );
}

// ── Dashboard ────────────────────────────────────────────────────
export function FuelDashboard() {
  const { today, path } = useAuth();
  const navigate = useNavigate();
  const dash = useLoad(() => get('/dashboard', { business: F }), []);
  const days = useLoad(() => get('/fuel/days', { from: addDays(today, -29), to: today }), [today]);
  const rates = useLoad(() => get('/rates'), []);
  if (!dash.data || !days.data) return dash.error || days.error ? <ErrorBox error={dash.error || days.error} /> : <PageSkeleton />;

  const rate: number | null = rates.data?.current?.rate ?? null;
  const methods: { id: string; name: string }[] = days.data.methods;
  const t = days.data.days.find((d: any) => d.entry_date === today) ?? { sales: 0, liters: 0, received: 0, debts: 0, outstanding: 0, by_method: {}, entries: 0 };
  const week = days.data.days.filter((d: any) => d.entry_date >= addDays(today, -6));
  const unsettled = days.data.days.filter((d: any) => d.outstanding > 0);
  const unsettledTotal = unsettled.reduce((s: number, d: any) => s + d.outstanding, 0);
  const owed = dash.data.receivable.find((r: any) => r.business_id === F);
  const balances = dash.data.cash.filter((c: any) => c.business_id === F);
  const alerts = dash.data.alerts.filter((a: any) => a.business === F).slice(0, 6);
  const reload = () => { dash.reload(); days.reload(); rates.reload(); };

  return (
    <div className="dashboard">
      <PageHeader icon={<Home size={22} />} title="Fuel station dashboard" subtitle={dash.data.today}
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={reload}><RefreshCw size={14} /> Refresh</button>} />
      <RateBanner rates={rates} />

      <section className="stat-grid">
        <Stat label="Sales today" value={money(t.sales)} sub={`${num(t.liters)} L${slsh(t.sales, rate) ? ` · ${slsh(t.sales, rate)}` : ''}`} />
        <Stat label="Today's accounting" value={!t.entries ? 'No sales yet' : t.outstanding === 0 ? 'Settled ✓' : t.outstanding > 0 ? money(t.outstanding) : `Over ${money(-t.outstanding)}`}
          tone={!t.entries ? undefined : t.outstanding === 0 ? 'green' : t.outstanding > 0 ? undefined : 'red'}
          sub={!t.entries ? 'Record today in Sales' : t.outstanding === 0 ? 'Every dollar accounted for' : t.outstanding > 0 ? 'outstanding today' : undefined} />
        <button type="button" className="stat stat--link" onClick={() => navigate(path('/customers'))}>
          <span className="stat__label">Customers owe</span><strong className="stat__value">{money(owed?.total ?? 0)}</strong>
          <span className="stat__sub">{owed?.parties ?? 0} customers · open Credit Customers →</span>
        </button>
        <Stat label="Outstanding (30 days)" value={money(unsettledTotal)} tone={unsettledTotal > 0 ? 'red' : 'green'}
          sub={unsettled.length ? `${unsettled.length} ${unsettled.length === 1 ? 'day' : 'days'} not fully accounted for` : 'all days settled'} />
      </section>

      <div className="grid-2">
        <div className="panel">
          <div className="panel__header"><div><p>Today</p><h2>How it was received</h2></div></div>
          <div className="kv">
            {methods.map((m) => <Fragment key={m.id}><span>{m.name}</span><span>{money(t.by_method[m.id] ?? 0)}</span></Fragment>)}
            <span>Customer debts</span><span>{money(t.debts)}</span>
            <span className="kv-total">Total accounted for</span><span className="kv-total">{money(t.received + t.debts)} of {money(t.sales)}</span>
          </div>
        </div>
        <div className="panel">
          <div className="panel__header"><div><p>Balances</p><h2>Money held</h2></div></div>
          <div className="kv">
            {balances.map((b: any) => <Fragment key={b.method_id}><span>{b.method_name}</span><span>{money(b.balance)}</span></Fragment>)}
            <span className="kv-total">Total</span><span className="kv-total">{money(balances.reduce((s: number, b: any) => s + b.balance, 0))}</span>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>{rate ? `${rateText(rate)}${rates.data?.current ? ` · set ${rates.data.current.rate_date} by ${rates.data.current.set_by_name}` : ''}` : 'No exchange rate set.'}</p>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="panel">
          <div className="panel__header"><div><p>Needs attention</p><h2>Alerts</h2></div></div>
          <div className="form-stack">
            {alerts.map((a: any, i: number) => <div key={i} className={a.level === 'red' ? 'mc-error' : 'mc-warn'}><strong>{a.title}</strong><div className="small">{a.detail}</div></div>)}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel__header"><div><p>Last 7 days</p><h2>Daily sales</h2></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th className="num">Litres</th><th className="num">Sales</th>{methods.map((m) => <th key={m.id} className="num">{m.name}</th>)}<th className="num">Debts</th><th>Status</th></tr></thead>
            <tbody>
              {week.map((d: any) => (
                <tr key={d.entry_date}><td>{d.entry_date}</td><td className="num">{num(d.liters)}</td><td className="num"><strong>{money(d.sales)}</strong></td>
                  {methods.map((m) => <td key={m.id} className="num">{money(d.by_method[m.id] ?? 0)}</td>)}<td className="num">{money(d.debts)}</td><td><Settlement outstanding={d.outstanding} /></td></tr>
              ))}
              {!week.length && <tr><td colSpan={methods.length + 5} className="muted">No sales recorded in the last 7 days.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Reports ──────────────────────────────────────────────────────
export function FuelReports() {
  const { today } = useAuth();
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const r = useLoad(() => get('/fuel/days', { from, to }), [from, to]);
  const fuels = useLoad(() => get('/fuel/reconciliation', { from, to }), [from, to]);
  const d = r.data;
  const sum = (k: string) => (d?.days ?? []).reduce((s: number, x: any) => s + x[k], 0);
  const sumM = (id: string) => (d?.days ?? []).reduce((s: number, x: any) => s + (x.by_method[id] ?? 0), 0);
  const sumSlsh = (d?.days ?? []).reduce((s: number, x: any) => s + (x.rate ? Math.round((x.sales / 100) * x.rate) : 0), 0);
  const hasRate = (d?.days ?? []).some((x: any) => x.rate);
  return (
    <div className="module-page">
      <PageHeader icon={<BarChart3 size={22} />} title="Daily reconciliation" subtitle={`${from} to ${to}`}
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button>} />
      <div className="no-print"><DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} /></div>
      <ErrorBox error={r.error} />
      {d && (
        <div className="print-area form-stack">
          <img className="print-only print-logo" src="/logo-full.svg" alt="Meecaad" />
          <h3 className="print-only">Meecaad Fuel Station — daily reconciliation {from} to {to}</h3>
          <section className="stat-grid">
            <Stat label="Sales" value={money(sum('sales'))} sub={`${num(sum('liters'))} L${hasRate ? ` · ${sumSlsh.toLocaleString('en-US')} SLSH` : ''}`} />
            <Stat label="Received" value={money(sum('received'))} sub={d.methods.map((m: any) => `${m.name} ${money(sumM(m.id))}`).join(' · ')} />
            <Stat label="Customer debts" value={money(sum('debts'))} />
            <Stat label="Outstanding" value={money(sum('outstanding'))} tone={sum('outstanding') > 0 ? 'red' : 'green'} sub={sum('outstanding') > 0 ? 'not yet received' : 'everything accounted for'} />
          </section>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th className="num">Litres</th><th className="num">Sales</th>{hasRate && <th className="num">Sales (SLSH)</th>}{d.methods.map((m: any) => <th key={m.id} className="num">{m.name}</th>)}<th className="num">Debts</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
              <tbody>
                {d.days.map((x: any) => (
                  <tr key={x.entry_date}><td>{x.entry_date}{x.rate && <div className="small muted">{x.rate.toLocaleString('en-US')} SLSH/$</div>}</td><td className="num">{num(x.liters)}</td><td className="num"><strong>{money(x.sales)}</strong></td>
                    {hasRate && <td className="num">{x.rate ? Math.round((x.sales / 100) * x.rate).toLocaleString('en-US') : '—'}</td>}
                    {d.methods.map((m: any) => <td key={m.id} className="num">{money(x.by_method[m.id] ?? 0)}</td>)}
                    <td className="num">{money(x.debts)}</td><td className="num"><Money c={x.outstanding} signed /></td><td><Settlement outstanding={x.outstanding} /></td></tr>
                ))}
                {!d.days.length && <tr><td colSpan={d.methods.length + 7} className="muted">No sales recorded in this period.</td></tr>}
                {d.days.length > 0 && (
                  <tr><td><strong>Total</strong></td><td className="num"><strong>{num(sum('liters'))}</strong></td><td className="num"><strong>{money(sum('sales'))}</strong></td>
                    {hasRate && <td className="num"><strong>{sumSlsh.toLocaleString('en-US')}</strong></td>}
                    {d.methods.map((m: any) => <td key={m.id} className="num"><strong>{money(sumM(m.id))}</strong></td>)}
                    <td className="num"><strong>{money(sum('debts'))}</strong></td><td className="num"><strong>{money(sum('outstanding'))}</strong></td><td></td></tr>
                )}
              </tbody>
            </table>
          </div>
          {fuels.data && fuels.data.byFuel.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Fuel</th><th className="num">Litres sold</th><th className="num">Sales</th></tr></thead>
                <tbody>{fuels.data.byFuel.map((x: any) => <tr key={x.fuel_name}><td>{x.fuel_name}</td><td className="num">{num(x.liters)}</td><td className="num">{money(x.amount)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────
const SETTINGS_TABS = [
  { key: 'rate', label: 'Exchange rate' }, { key: 'prices', label: 'Fuel prices' }, { key: 'pumps', label: 'Pumps & tanks' }, { key: 'tanks', label: 'Tank checks' },
  { key: 'deliveries', label: 'Deliveries' }, { key: 'expenses', label: 'Expenses' }, { key: 'suppliers', label: 'Suppliers' },
];

export function FuelSettings() {
  const [tab, setTab] = useState('rate');
  const setup = useLoad(() => get('/fuel/setup'), []);
  return (
    <div className="module-page">
      <PageHeader icon={<Settings size={22} />} title="Settings" subtitle="Daily exchange rate, fuel prices, pumps, deliveries and expenses" />
      <div className="panel" style={{ paddingBottom: 0 }}><Tabs tabs={SETTINGS_TABS} activeTab={tab} onTabChange={setTab} /></div>
      {tab === 'rate' && <RateSettings />}
      {tab === 'prices' && <StockPage view="fuels" />}
      {tab === 'pumps' && <div className="panel"><Setup data={setup.data} onChange={setup.reload} /></div>}
      {tab === 'tanks' && <div className="panel form-stack"><Dips tanks={setup.data?.tanks ?? []} onSaved={setup.reload} /><Reconciliation /></div>}
      {tab === 'deliveries' && <PurchasesPage />}
      {tab === 'expenses' && <ExpensesPage />}
      {tab === 'suppliers' && <PartiesPage kind="suppliers" />}
    </div>
  );
}

function RateSettings() {
  const { today } = useAuth();
  const rates = useLoad(() => get('/rates'), []);
  const [rate, setRate] = useState('');
  const [date, setDate] = useState(today);
  const { run, busy } = useSubmit();
  const cur = rates.data?.current;
  const value = Number(rate.replace(/,/g, ''));
  const save = async () => {
    const r = await run((key) => post('/rates', { rate: value, date }, key), 'Exchange rate saved');
    if (r) { setRate(''); rates.reload(); }
  };
  return (
    <div className="form-stack">
      <div className="panel form-stack">
        <div className="panel__header"><div><p>Somaliland Shillings per US dollar</p><h2>{cur ? rateText(cur.rate) : 'Not set yet'}</h2></div></div>
        {cur && <p className="small muted" style={{ margin: 0 }}>In force since {cur.rate_date} · set by {cur.set_by_name}</p>}
        {rates.data && !rates.data.setToday && <div className="mc-warn">Today's rate is not set. Enter it below so today's SLSH amounts are right.</div>}
        <div className="form-row-3">
          <Field label="$1 equals (SLSH)"><input className="form-input" inputMode="decimal" value={rate} placeholder="e.g. 11,900" onChange={(e) => setRate(e.target.value.replace(/[^0-9.,]/g, ''))} /></Field>
          <Field label="From date"><input type="date" className="form-input" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label=" "><button type="button" className="btn btn-primary" disabled={busy || !(value >= 1)} onClick={save}>Save rate</button></Field>
        </div>
        {value >= 1 && <p className="small muted" style={{ margin: 0 }}>Example: $100 = {Math.round(value * 100).toLocaleString('en-US')} SLSH · 1,000,000 SLSH = {money(Math.round((1_000_000 / value) * 100))}</p>}
        <p className="small muted" style={{ margin: 0 }}>Amounts are kept in US dollars. The rate shows what they are worth in Shillings, and lets the cashier count cash in Shillings. Each day uses the latest rate set on or before it. Old rates are kept.</p>
      </div>
      <div className="panel">
        <div className="panel__header"><div><p>History</p><h2>Rates</h2></div></div>
        <ErrorBox error={rates.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>From</th><th className="num">SLSH per $1</th><th>Set by</th><th>When</th></tr></thead>
            <tbody>
              {(rates.data?.history ?? []).map((h: any) => <tr key={h.id}><td>{h.rate_date}</td><td className="num"><strong>{h.rate.toLocaleString('en-US')}</strong></td><td>{h.set_by_name}</td><td className="small">{fmtTime(h.set_at)}</td></tr>)}
              {!rates.loading && !rates.data?.history?.length && <tr><td colSpan={4} className="muted">No rate has been set yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
