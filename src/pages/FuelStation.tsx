// Fuel station, the way it is run:
//   Sales — open a shift with the fuel it works with (e.g. 2,000 L = $2,000), record every
//           sale (Cash / Zaad / Edahab or a customer debt), then Xisaab xidh: when the sales
//           match the opening value the shift is done and the next one opens.
//   Shifts, Expenses, Dashboard, Reports, Settings (exchange rate).
import { Fragment, useState } from 'react';
import { BarChart3, CheckCircle2, ClipboardCheck, Fuel, History, Home, Printer, RefreshCw, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { fromCents, get, money, num, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { PageSkeleton } from '../components/LoadingSpinner';
import { DateRange, ErrorBox, Field, MoneyInput, PageHeader, PartySelect, ReasonModal, Stat, addDays, fmtTime, useFilters, useLoad, useSubmit } from '../components/ui';

/** "14,280,000 SLSH" for an amount in cents at a rate (SLSH per $1), or null when there is no rate. */
const slsh = (cents: number, rate: number | null | undefined) => (rate ? `${Math.round((cents / 100) * rate).toLocaleString('en-US')} SLSH` : null);
const rateText = (rate: number) => `$1 = ${rate.toLocaleString('en-US')} SLSH`;
const perLitre = (s: any) => money(Math.round(s.opening_value / s.opening_liters));

/** Open / Matched / Not matched. */
function ShiftStatus({ s }: { s: any }) {
  if (s.status === 'open') return <StatusBadge label="Open" tone="yellow" />;
  return s.remaining === 0 ? <StatusBadge label="Matched" tone="green" /> : <StatusBadge label={`Not matched ${money(Math.abs(s.remaining))}`} tone="red" />;
}

/** What came in per payment method + debts, and whether it matches the opening value. */
function Count({ s, methods }: { s: any; methods: { id: string; name: string }[] }) {
  const left = s.status === 'open' ? s.remaining_now : s.remaining;
  return (
    <div className="kv">
      {methods.map((m) => <Fragment key={m.id}><span>{m.name}</span><span>{money(s.by_method[m.id] ?? 0)}</span></Fragment>)}
      <span>Customer debts</span><span>{money(s.debts)}</span>
      <span className="kv-total">Total sold</span><span className="kv-total">{money(s.sold)} of {money(s.opening_value)}</span>
      <span className="kv-total">{left === 0 ? 'Matched' : left > 0 ? 'Remaining' : 'Over'}</span>
      <span className="kv-total" style={{ color: left === 0 ? '#15803d' : '#b91c1c' }}>{left === 0 ? '✓' : money(Math.abs(left))}</span>
    </div>
  );
}

// ── Sales: open shift → record sales → xisaab xidh ──────────────
export function FuelSalesPage() {
  const { can, activeMethods } = useAuth();
  const cur = useLoad(() => get('/fuel/current'), []);
  const customers = useLoad(() => get('/customers', { business: 'fuel' }), []);
  const [slip, setSlip] = useState<any>(null);
  const [closing, setClosing] = useState(false);
  const [voiding, setVoiding] = useState<any>(null);
  const d = cur.data;
  const s = d?.shift;
  const reload = () => { cur.reload(); customers.reload(); };

  return (
    <div className="module-page">
      <PageHeader icon={<Fuel size={22} />} title="Sales"
        subtitle={s ? `Shift #${s.number} · opened by ${s.opened_by_name} at ${fmtTime(s.opened_at)}${d.rate ? ` · ${rateText(d.rate)}` : ''}` : 'Open a shift with the fuel you are working with'}
        actions={s && can('fuel') && <button type="button" className="btn btn-primary" onClick={() => setClosing(true)}><ClipboardCheck size={16} /> Xisaab xidh</button>} />
      <ErrorBox error={cur.error} />
      {!d && !cur.error && <PageSkeleton />}
      {d && !s && (can('fuel') ? <OpenShift last={d.last} onDone={reload} /> : <div className="panel"><p className="muted">No shift is open.</p></div>)}
      {s && (
        <>
          <section className="stat-grid">
            <Stat label="Opening" value={money(s.opening_value)} sub={`${num(s.opening_liters)} L · ${perLitre(s)}/L`} />
            <Stat label="Sold" value={money(s.sold)} sub={`${num(s.liters)} L · ${s.count} sales`} />
            <Stat label="Remaining" value={money(s.remaining_now)} tone={s.remaining_now === 0 ? 'green' : undefined} sub={s.remaining_now === 0 ? 'Matched — ready for xisaab xidh' : `${num(s.remaining_liters)} L left`} />
            <Stat label="Cash · Zaad · Edahab" value={money(s.sold - s.debts)} sub={`debts ${money(s.debts)}`} />
          </section>
          {can('fuel') && <NewSale shift={s} rate={d.rate} customers={customers} onDone={reload} />}
          <div className="grid-2">
            <div className="panel">
              <div className="panel__header"><div><p>This shift</p><h2>Sales</h2></div></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Time</th><th className="num">Amount</th><th className="num">Litres</th><th>Paid with</th><th>By</th><th></th></tr></thead>
                  <tbody>
                    {d.sales.map((x: any) => (
                      <tr key={x.id} style={{ opacity: x.status === 'voided' ? 0.5 : 1 }}>
                        <td className="small">{fmtTime(x.created_at)}</td>
                        <td className="num"><strong>{money(x.amount)}</strong>{x.slsh_amount && <div className="small muted">{x.slsh_amount.toLocaleString('en-US')} SLSH</div>}</td>
                        <td className="num">{num(x.liters)}</td>
                        <td>{x.method_name ?? <>Debt: <strong>{x.customer_name}</strong></>}{x.status === 'voided' && <div><StatusBadge label="Cancelled" tone="red" /> <span className="small muted">{x.void_reason}</span></div>}</td>
                        <td className="small">{x.created_by_name}</td>
                        <td>{can('void') && x.status === 'completed' && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setVoiding(x)}>Cancel</button>}</td>
                      </tr>
                    ))}
                    {!d.sales.length && <tr><td colSpan={6} className="muted">No sales yet in this shift.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="panel">
              <div className="panel__header"><div><p>Xisaab xidh</p><h2>Count so far</h2></div></div>
              <Count s={s} methods={activeMethods} />
              {can('fuel') && <div className="form-actions"><button type="button" className="btn btn-primary" onClick={() => setClosing(true)}><ClipboardCheck size={16} /> Close shift (xisaab xidh)</button></div>}
            </div>
          </div>
        </>
      )}
      {closing && s && <CloseShift s={s} methods={activeMethods} onClose={() => setClosing(false)}
        onDone={async (id) => { setClosing(false); setSlip(await get(`/fuel/sessions/${id}`)); reload(); }} />}
      {slip && <ShiftSlip s={slip} rate={d?.rate} onClose={() => setSlip(null)} />}
      {voiding && <ReasonModal open onClose={() => setVoiding(null)} title="Cancel this sale?" action={`/fuel/sales/${voiding.id}/void`} confirmLabel="Cancel sale"
        message={<>{money(voiding.amount)} · {voiding.method_name ?? `debt of ${voiding.customer_name}`}. The money is taken off this shift.</>} onDone={reload} />}
    </div>
  );
}

function OpenShift({ last, onDone }: { last: any; onDone: () => void }) {
  const [liters, setLiters] = useState('');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const { run, busy } = useSubmit();
  const l = Number(liters), v = toCents(value);
  const carry = last && last.remaining > 0 ? last : null;
  const open = async () => {
    if (await run((key) => post('/fuel/open', { liters: l, value: v, note }, key), 'Shift opened')) onDone();
  };
  return (
    <div className="panel form-stack">
      <div className="panel__header"><div><p>Start</p><h2>Open shift</h2></div></div>
      <p className="small muted" style={{ margin: 0 }}>Enter the fuel this shift works with and what it is worth, e.g. 2,000 L = $2,000. At the end, the sales must add up to this.</p>
      {carry && (
        <div className="mc-note">Shift #{carry.number} closed with {money(carry.remaining)} ({num(carry.remaining_liters)} L) left.{' '}
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => { setLiters(String(carry.remaining_liters)); setValue(fromCents(carry.remaining)); }}>Use it as the start</button></div>
      )}
      <div className="form-row-3">
        <Field label="Litres"><input className="form-input" inputMode="decimal" value={liters} onChange={(e) => setLiters(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="2000" autoFocus /></Field>
        <Field label="Value (USD)"><MoneyInput value={value} onChange={setValue} placeholder="2000.00" /></Field>
        <Field label="Note (optional)"><input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. morning shift" /></Field>
      </div>
      {l > 0 && v > 0 && <p className="small" style={{ margin: 0 }}>Price: <strong>{money(Math.round(v / l))} per litre</strong></p>}
      <div className="form-actions"><button type="button" className="btn btn-primary" disabled={busy || !(l > 0) || !(v > 0)} onClick={open}>Open shift</button></div>
    </div>
  );
}

function NewSale({ shift, rate, customers, onDone }: { shift: any; rate: number | null; customers: { data: any; reload: () => void }; onDone: () => void }) {
  const { activeMethods } = useAuth();
  const [amount, setAmount] = useState('');
  const [inSlsh, setInSlsh] = useState(false);
  const [method, setMethod] = useState('cash');   // a payment method id, or 'debt'
  const [customer, setCustomer] = useState('');
  const { run, busy } = useSubmit();
  const usd = inSlsh && rate ? Math.round((Number(amount || 0) / rate) * 100) : toCents(amount);
  const litres = shift.price ? usd / shift.price : 0;
  const tooMuch = usd > shift.remaining_now;
  const ok = usd > 0 && !tooMuch && (method !== 'debt' || customer);
  const save = async () => {
    if (!ok || busy) return;
    const body = method === 'debt' ? { customer, amount: usd } : inSlsh ? { method: 'cash', slsh: amount } : { method, amount: usd };
    if (await run((key) => post('/fuel/sales', body, key), `Sale ${money(usd)} recorded`)) { setAmount(''); setCustomer(''); onDone(); }
  };
  const pick = (m: string) => { setMethod(m); if (m !== 'cash') setInSlsh(false); };
  return (
    <div className="panel form-stack">
      <div className="panel__header"><div><p>New</p><h2>Record a sale</h2></div></div>
      <div className="method-picker">
        {activeMethods.map((m) => <button key={m.id} type="button" className={`btn ${method === m.id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => pick(m.id)}>{m.name}</button>)}
        <button type="button" className={`btn ${method === 'debt' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => pick('debt')}>Customer debt</button>
      </div>
      {method === 'debt' && <PartySelect kind="customers" value={customer} items={customers.data ?? []} placeholder="Choose customer…" onCreated={customers.reload} onChange={setCustomer} />}
      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px' }}>
          <Field label={inSlsh ? 'Amount (SLSH)' : 'Amount (USD)'}>
            <input className="form-input" inputMode="decimal" style={{ fontSize: 22, minHeight: 52 }} value={amount} placeholder={inSlsh ? '0' : '0.00'}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
          </Field>
        </div>
        {rate && method === 'cash' && (
          <div className="row" style={{ gap: 4, flexWrap: 'nowrap', paddingBottom: 6 }}>
            <button type="button" className={`btn btn-sm ${!inSlsh ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setInSlsh(false); setAmount(''); }}>USD</button>
            <button type="button" className={`btn btn-sm ${inSlsh ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setInSlsh(true); setAmount(''); }}>SLSH</button>
          </div>
        )}
        <button type="button" className="btn btn-primary" style={{ minHeight: 52, minWidth: 180 }} disabled={!ok || busy} onClick={save}>Record sale {usd > 0 ? money(usd) : ''}</button>
      </div>
      {usd > 0 && (
        <p className="small" style={{ margin: 0, color: tooMuch ? '#b91c1c' : undefined }}>
          {tooMuch ? `More than what is left in this shift (${money(shift.remaining_now)}).` : <>= {money(usd)}{inSlsh ? '' : slsh(usd, rate) ? ` · ${slsh(usd, rate)}` : ''} · {num(Math.round(litres * 1000) / 1000)} L</>}
        </p>
      )}
    </div>
  );
}

function CloseShift({ s, methods, onClose, onDone }: { s: any; methods: { id: string; name: string }[]; onClose: () => void; onDone: (id: string) => void }) {
  const [explanation, setExplanation] = useState('');
  const { run, busy } = useSubmit();
  const matched = s.remaining_now === 0;
  const close = async () => {
    const r = await run((key) => post('/fuel/close', { explanation }, key), 'Shift closed');
    if (r) onDone(r.id);
  };
  return (
    <Modal open onClose={onClose} title={`Xisaab xidh — shift #${s.number}`} width="md"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Back</button>
        <button type="button" className="btn btn-primary" disabled={busy || (!matched && !explanation.trim())} onClick={close}>Close shift</button></>}>
      <div className="form-stack">
        <Count s={s} methods={methods} />
        {matched
          ? <div className="mc-note"><CheckCircle2 size={14} style={{ verticalAlign: -2 }} /> Matched: {money(s.opening_value)} fully accounted for. The next shift can open.</div>
          : <>
            <div className="mc-error">Not matched: {money(Math.abs(s.remaining_now))} {s.remaining_now > 0 ? `less than the opening value (${num(s.remaining_liters)} L)` : 'more than the opening value'}. Explain it to close.</div>
            <Field label="Explanation (required)"><input className="form-input" value={explanation} onChange={(e) => setExplanation(e.target.value)} placeholder="e.g. fuel left over for the next shift" /></Field>
          </>}
      </div>
    </Modal>
  );
}

/** A shift with all its sales: printable. */
function ShiftSlip({ s, rate, onClose }: { s: any; rate?: number | null; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={`Shift #${s.number} · ${s.entry_date}`} width="lg"
      footer={<button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print</button>}>
      <div className="print-area form-stack">
        <img className="print-only print-logo" src="/logo-full.svg" alt="Meecaad" />
        <h3 style={{ margin: 0 }}>Meecaad Fuel Station — shift #{s.number}</h3>
        <p className="small" style={{ margin: 0 }}>
          Opened {fmtTime(s.opened_at)} by {s.opened_by_name} · {num(s.opening_liters)} L = {money(s.opening_value)} ({perLitre(s)}/L){slsh(s.opening_value, s.rate ?? rate) && ` · ${slsh(s.opening_value, s.rate ?? rate)}`}
          {s.closed_at && <><br />Closed {fmtTime(s.closed_at)} by {s.closed_by_name}</>}
        </p>
        <ShiftStatus s={s} />
        <Count s={s} methods={s.methods} />
        {s.explanation && <p style={{ margin: 0 }}><strong>Explanation:</strong> {s.explanation}</p>}
        <table>
          <thead><tr><th>Time</th><th className="num">Amount</th><th className="num">Litres</th><th>Paid with</th><th>By</th></tr></thead>
          <tbody>
            {s.sales.map((x: any) => (
              <tr key={x.id} style={{ textDecoration: x.status === 'voided' ? 'line-through' : undefined }}>
                <td className="small">{fmtTime(x.created_at)}</td><td className="num">{money(x.amount)}{x.slsh_amount && <span className="small muted"> ({x.slsh_amount.toLocaleString('en-US')} SLSH)</span>}</td>
                <td className="num">{num(x.liters)}</td><td>{x.method_name ?? `Debt: ${x.customer_name}`}{x.status === 'voided' && ` — cancelled: ${x.void_reason}`}</td><td className="small">{x.created_by_name}</td>
              </tr>
            ))}
            {!s.sales.length && <tr><td colSpan={5} className="muted">No sales.</td></tr>}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// ── Shifts ──────────────────────────────────────────────────────
export function FuelShiftsPage() {
  const { today } = useAuth();
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const list = useLoad(() => get('/fuel/sessions', { from, to }), [from, to]);
  const [slip, setSlip] = useState<any>(null);
  const methods: { id: string; name: string }[] = list.data?.methods ?? [];
  const filter = useFilters<any>(list.data?.shifts ?? [], [
    { key: 'status', label: 'Status', get: (s) => (s.status === 'open' ? 'Open' : s.remaining === 0 ? 'Matched' : 'Not matched') },
    { key: 'by', label: 'Opened by', get: (s) => s.opened_by_name },
  ]);
  return (
    <div className="module-page">
      <PageHeader icon={<History size={22} />} title="Shifts" subtitle="Every shift: what it started with, what was sold, and whether it matched" />
      <div className="panel">
        <div style={{ marginBottom: 12 }}><DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} /></div>
        <ErrorBox error={list.error} />
        {filter.bar}
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Date</th><th className="num">Opening</th><th className="num">Sold</th>{methods.map((m) => <th key={m.id} className="num">{m.name}</th>)}<th className="num">Debts</th><th>Status</th><th>Opened / closed by</th></tr></thead>
            <tbody>
              {filter.shown.map((s: any) => (
                <tr key={s.id} className="tr--clickable" onClick={async () => setSlip(await get(`/fuel/sessions/${s.id}`))}>
                  <td><strong>{s.number}</strong></td>
                  <td className="small">{s.entry_date}<div className="muted">{fmtTime(s.opened_at)}</div></td>
                  <td className="num">{money(s.opening_value)}<div className="small muted">{num(s.opening_liters)} L</div></td>
                  <td className="num"><strong>{money(s.sold)}</strong></td>
                  {methods.map((m) => <td key={m.id} className="num">{money(s.by_method[m.id] ?? 0)}</td>)}
                  <td className="num">{money(s.debts)}</td>
                  <td><ShiftStatus s={s} />{s.explanation && <div className="small muted" style={{ maxWidth: 220, whiteSpace: 'normal' }}>{s.explanation}</div>}</td>
                  <td className="small">{s.opened_by_name}{s.closed_by_name && <div className="muted">closed: {s.closed_by_name}</div>}</td>
                </tr>
              ))}
              {!list.loading && !filter.shown.length && <tr><td colSpan={methods.length + 7} className="muted">No shifts in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {slip && <ShiftSlip s={slip} onClose={() => setSlip(null)} />}
    </div>
  );
}

// ── Dashboard ───────────────────────────────────────────────────
export function FuelDashboard() {
  const { today, path, activeMethods } = useAuth();
  const navigate = useNavigate();
  const cur = useLoad(() => get('/fuel/current'), []);
  const dash = useLoad(() => get('/dashboard', { business: 'fuel' }), []);
  const week = useLoad(() => get('/fuel/sessions', { from: addDays(today, -6), to: today }), [today]);
  if (!cur.data || !dash.data || !week.data) return cur.error || dash.error || week.error ? <ErrorBox error={cur.error || dash.error || week.error} /> : <PageSkeleton />;
  const s = cur.data.shift;
  const rate = cur.data.rate;
  const todays = week.data.shifts.filter((x: any) => x.entry_date === today);
  const soldToday = todays.reduce((t: number, x: any) => t + x.sold, 0);
  const owed = dash.data.receivable.find((r: any) => r.business_id === 'fuel');
  const balances = dash.data.cash.filter((c: any) => c.business_id === 'fuel');
  const alerts = dash.data.alerts.filter((a: any) => a.business === 'fuel').slice(0, 6);
  const reload = () => { cur.reload(); dash.reload(); week.reload(); };
  return (
    <div className="dashboard">
      <PageHeader icon={<Home size={22} />} title="Fuel station dashboard" subtitle={dash.data.today}
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={reload}><RefreshCw size={14} /> Refresh</button>} />
      <section className="stat-grid">
        <Stat label="Sales today" value={money(soldToday)} sub={`${todays.length} ${todays.length === 1 ? 'shift' : 'shifts'}${slsh(soldToday, rate) ? ` · ${slsh(soldToday, rate)}` : ''}`} />
        <button type="button" className="stat stat--link" onClick={() => navigate(path('/sales'))}>
          <span className="stat__label">Current shift</span>
          <strong className="stat__value">{s ? `#${s.number} · ${money(s.remaining_now)} left` : 'No shift open'}</strong>
          <span className="stat__sub">{s ? `sold ${money(s.sold)} of ${money(s.opening_value)} · open Sales →` : 'open Sales to start one →'}</span>
        </button>
        <button type="button" className="stat stat--link" onClick={() => navigate(path('/customers'))}>
          <span className="stat__label">Customers owe</span><strong className="stat__value">{money(owed?.total ?? 0)}</strong>
          <span className="stat__sub">{owed?.parties ?? 0} customers · open Credit Customers →</span>
        </button>
        <Stat label="Exchange rate" value={rate ? `${rate.toLocaleString('en-US')} SLSH` : 'Not set'} sub={rate ? 'for $1' : 'set it in Settings'} />
      </section>
      <div className="grid-2">
        <div className="panel">
          <div className="panel__header"><div><p>{s ? `Shift #${s.number}` : 'No shift open'}</p><h2>Xisaab so far</h2></div></div>
          {s ? <Count s={s} methods={activeMethods} /> : <p className="muted">Open a shift in Sales.</p>}
        </div>
        <div className="panel">
          <div className="panel__header"><div><p>Balances</p><h2>Money held</h2></div></div>
          <div className="kv">
            {balances.map((b: any) => <Fragment key={b.method_id}><span>{b.method_name}</span><span>{money(b.balance)}</span></Fragment>)}
            <span className="kv-total">Total</span><span className="kv-total">{money(balances.reduce((t: number, b: any) => t + b.balance, 0))}</span>
          </div>
        </div>
      </div>
      {alerts.length > 0 && (
        <div className="panel">
          <div className="panel__header"><div><p>Needs attention</p><h2>Alerts</h2></div></div>
          <div className="form-stack">{alerts.map((a: any, i: number) => <div key={i} className={a.level === 'red' ? 'mc-error' : 'mc-warn'}><strong>{a.title}</strong><div className="small">{a.detail}</div></div>)}</div>
        </div>
      )}
      <div className="panel">
        <div className="panel__header"><div><p>Last 7 days</p><h2>Shifts</h2></div><button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(path('/shifts'))}>All shifts →</button></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Date</th><th className="num">Opening</th><th className="num">Sold</th>{week.data.methods.map((m: any) => <th key={m.id} className="num">{m.name}</th>)}<th className="num">Debts</th><th>Status</th></tr></thead>
            <tbody>
              {week.data.shifts.map((x: any) => (
                <tr key={x.id}><td>{x.number}</td><td>{x.entry_date}</td><td className="num">{money(x.opening_value)}</td><td className="num"><strong>{money(x.sold)}</strong></td>
                  {week.data.methods.map((m: any) => <td key={m.id} className="num">{money(x.by_method[m.id] ?? 0)}</td>)}<td className="num">{money(x.debts)}</td><td><ShiftStatus s={x} /></td></tr>
              ))}
              {!week.data.shifts.length && <tr><td colSpan={week.data.methods.length + 6} className="muted">No shifts in the last 7 days.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Reports: daily reconciliation ───────────────────────────────
export function FuelReports() {
  const { today } = useAuth();
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const r = useLoad(() => get('/fuel/sessions', { from, to }), [from, to]);
  const d = r.data;
  const methods: { id: string; name: string }[] = d?.methods ?? [];
  // One row per day: all its shifts added up.
  const days = Object.values((d?.shifts ?? []).reduce((acc: Record<string, any>, s: any) => {
    const x = acc[s.entry_date] ?? (acc[s.entry_date] = { date: s.entry_date, shifts: 0, open: 0, opening: 0, sold: 0, debts: 0, by: {} as Record<string, number>, left: 0, rate: s.rate, slsh: 0 });
    x.shifts++; if (s.status === 'open') x.open++;
    x.opening += s.opening_value; x.sold += s.sold; x.debts += s.debts; x.left += s.status === 'open' ? s.remaining_now : s.remaining;
    if (s.rate) x.slsh += Math.round((s.sold / 100) * s.rate);
    for (const m of methods) x.by[m.id] = (x.by[m.id] ?? 0) + (s.by_method[m.id] ?? 0);
    return acc;
  }, {})).sort((a: any, b: any) => (a.date < b.date ? 1 : -1)) as any[];
  const total = (k: string) => days.reduce((t, x) => t + x[k], 0);
  const totalM = (id: string) => days.reduce((t, x) => t + (x.by[id] ?? 0), 0);
  const hasRate = days.some((x) => x.rate);
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
            <Stat label="Sold" value={money(total('sold'))} sub={hasRate ? `${total('slsh').toLocaleString('en-US')} SLSH` : `${d.shifts.length} shifts`} />
            <Stat label="Received" value={money(total('sold') - total('debts'))} sub={methods.map((m) => `${m.name} ${money(totalM(m.id))}`).join(' · ')} />
            <Stat label="Customer debts" value={money(total('debts'))} />
            <Stat label="Not matched" value={money(days.reduce((t, x) => t + Math.abs(x.open ? 0 : x.left), 0))} tone={days.some((x) => !x.open && x.left !== 0) ? 'red' : 'green'} sub="closed shifts that did not match" />
          </section>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th className="num">Shifts</th><th className="num">Opening</th><th className="num">Sold</th>{hasRate && <th className="num">Sold (SLSH)</th>}{methods.map((m) => <th key={m.id} className="num">{m.name}</th>)}<th className="num">Debts</th><th>Status</th></tr></thead>
              <tbody>
                {days.map((x) => (
                  <tr key={x.date}><td>{x.date}{x.rate && <div className="small muted">{x.rate.toLocaleString('en-US')} SLSH/$</div>}</td><td className="num">{x.shifts}</td>
                    <td className="num">{money(x.opening)}</td><td className="num"><strong>{money(x.sold)}</strong></td>
                    {hasRate && <td className="num">{x.slsh ? x.slsh.toLocaleString('en-US') : '—'}</td>}
                    {methods.map((m) => <td key={m.id} className="num">{money(x.by[m.id] ?? 0)}</td>)}<td className="num">{money(x.debts)}</td>
                    <td>{x.open ? <StatusBadge label="Shift open" tone="yellow" /> : x.left === 0 ? <StatusBadge label="Matched" tone="green" /> : <StatusBadge label={`Not matched ${money(Math.abs(x.left))}`} tone="red" />}</td></tr>
                ))}
                {!days.length && <tr><td colSpan={methods.length + 6} className="muted">No shifts in this period.</td></tr>}
                {days.length > 0 && (
                  <tr><td><strong>Total</strong></td><td className="num"><strong>{total('shifts')}</strong></td><td className="num"><strong>{money(total('opening'))}</strong></td><td className="num"><strong>{money(total('sold'))}</strong></td>
                    {hasRate && <td className="num"><strong>{total('slsh').toLocaleString('en-US')}</strong></td>}
                    {methods.map((m) => <td key={m.id} className="num"><strong>{money(totalM(m.id))}</strong></td>)}<td className="num"><strong>{money(total('debts'))}</strong></td><td></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────
export function FuelSettings() {
  return (
    <div className="module-page">
      <PageHeader icon={<Settings size={22} />} title="Settings" subtitle="Daily exchange rate (USD → Somaliland Shillings)" />
      <RateSettings />
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
    if (await run((key) => post('/rates', { rate: value, date }, key), 'Exchange rate saved')) { setRate(''); rates.reload(); }
  };
  return (
    <div className="form-stack">
      <div className="panel form-stack">
        <div className="panel__header"><div><p>Somaliland Shillings per US dollar</p><h2>{cur ? rateText(cur.rate) : 'Not set yet'}</h2></div></div>
        {cur && <p className="small muted" style={{ margin: 0 }}>In force since {cur.rate_date} · set by {cur.set_by_name}</p>}
        {rates.data && !rates.data.setToday && <div className="mc-warn">Today's rate is not set. Enter it below.</div>}
        <div className="form-row-3">
          <Field label="$1 equals (SLSH)"><input className="form-input" inputMode="decimal" value={rate} placeholder="e.g. 11,900" onChange={(e) => setRate(e.target.value.replace(/[^0-9.,]/g, ''))} /></Field>
          <Field label="From date"><input type="date" className="form-input" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label=" "><button type="button" className="btn btn-primary" disabled={busy || !(value >= 1)} onClick={save}>Save rate</button></Field>
        </div>
        {value >= 1 && <p className="small muted" style={{ margin: 0 }}>Example: $100 = {Math.round(value * 100).toLocaleString('en-US')} SLSH · 1,000,000 SLSH = {money(Math.round((1_000_000 / value) * 100))}</p>}
        <p className="small muted" style={{ margin: 0 }}>Amounts are kept in US dollars. Cash can be taken in Shillings at this rate. Old rates are kept.</p>
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
