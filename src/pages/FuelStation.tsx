// Fuel station, the way it is run:
//   Sales     — a salesman opens their own shift, records the money collected
//               (Cash / Zaad / Edahab, or a customer debt) and closes the shift
//               when their time finishes. No opening fuel or money.
//   Shifts    — every shift: who, when (Hargeisa time), how much was collected.
//   Dashboard — what is happening now and plain numbers for decisions.
//   Reports, Settings (exchange rate, shift times).
import { Fragment, useState } from 'react';
import { BarChart3, ClipboardCheck, Clock, Fuel, History, Home, Lightbulb, Play, Printer, RefreshCw, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { get, money, patch, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { Tabs } from '../components/Tabs';
import { PageSkeleton } from '../components/LoadingSpinner';
import { DateRange, ErrorBox, Field, MoneyInput, PageHeader, PartySelect, ReasonModal, Stat, addDays, fmtClock, fmtDuration, fmtTime, useFilters, useLoad, usePolling, useSubmit } from '../components/ui';

/** "14,280,000 SLSH" for an amount in cents at a rate (SLSH per $1), or null when there is no rate. */
const slsh = (cents: number, rate: number | null | undefined) => (rate ? `${Math.round((cents / 100) * rate).toLocaleString('en-US')} SLSH` : null);
const rateText = (rate: number) => `$1 = ${rate.toLocaleString('en-US')} SLSH`;
const rateOn = (rates: { rate_date: string; rate: number; set_at: string }[], day: string) =>
  rates.filter((r) => r.rate_date <= day).sort((a, b) => (a.rate_date + a.set_at < b.rate_date + b.set_at ? 1 : -1))[0]?.rate ?? null;
const pct = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

/** ▲ 12% vs … (green) / ▼ 8% (red). */
function Trend({ now, before, label }: { now: number; before: number; label: string }) {
  const p = pct(now, before);
  if (p === null) return <span className="small muted">{before === 0 && now === 0 ? 'no sales yet' : `nothing ${label}`}</span>;
  return <span className={`trend ${p >= 0 ? 'trend--up' : 'trend--down'}`}>{p >= 0 ? '▲' : '▼'} {Math.abs(p)}% vs {label}</span>;
}

function Bar({ value, max, tone = 'var(--primary)' }: { value: number; max: number; tone?: string }) {
  return <div className="bar"><span style={{ width: `${max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0}%`, background: tone }} /></div>;
}

/** Open (until 14:00) / Overdue / Closed. */
function ShiftBadge({ s }: { s: any }) {
  if (s.status === 'closed') return <StatusBadge label="Closed" tone="green" />;
  if (s.overdue) return <StatusBadge label={`Overdue · should end ${fmtClock(s.ends_at)}`} tone="red" />;
  return <StatusBadge label={s.ends_at ? `Open · until ${fmtClock(s.ends_at)}` : 'Open'} tone="yellow" />;
}

/** What was collected: per payment method, customer debts, total. */
function Collected({ s, methods }: { s: any; methods: { id: string; name: string }[] }) {
  return (
    <div className="kv">
      {methods.map((m) => <Fragment key={m.id}><span>{m.name}</span><span>{money(s.by_method[m.id] ?? 0)}</span></Fragment>)}
      <span>Customer debts</span><span>{money(s.debts)}</span>
      <span className="kv-total">Total collected</span><span className="kv-total">{money(s.sold)}</span>
    </div>
  );
}

// ── Sales ───────────────────────────────────────────────────────
export function FuelSalesPage() {
  const { can, activeMethods } = useAuth();
  const cur = useLoad(() => get('/fuel/current'), []);
  usePolling(cur.reload, 20000);
  const customers = useLoad(() => get('/customers', { business: 'fuel' }), []);
  const [slip, setSlip] = useState<any>(null);
  const [closing, setClosing] = useState(false);
  const [voiding, setVoiding] = useState<any>(null);
  const d = cur.data;
  const s = d?.mine;
  const reload = () => { cur.reload(); customers.reload(); };
  const others = (d?.live ?? []).filter((x: any) => x.id !== s?.id);

  return (
    <div className="module-page">
      <PageHeader icon={<Fuel size={22} />} title="Sales"
        subtitle={s ? `${s.shift_name} shift #${s.number} · opened ${fmtClock(s.opened_at)} Hargeisa time${d.rate ? ` · ${rateText(d.rate)}` : ''}` : d?.owner ? 'What is happening in the shifts right now' : 'Open your shift, record the money you collect, close it when your time finishes'}
        actions={s && <button type="button" className="btn btn-primary" onClick={() => setClosing(true)}><ClipboardCheck size={16} /> Close my shift</button>} />
      <ErrorBox error={cur.error} />
      {!d && !cur.error && <PageSkeleton />}
      {d && !d.owner && !s && <OpenShift d={d} onDone={reload} onSlip={async (id) => setSlip(await get(`/fuel/sessions/${id}`))} />}
      {s && (
        <>
          {s.overdue && <div className="mc-error">Your shift time ended at {fmtClock(s.ends_at)}. Close your shift now.</div>}
          <section className="stat-grid">
            <Stat label="Collected this shift" value={money(s.sold)} sub={`${s.count} ${s.count === 1 ? 'sale' : 'sales'} · ${fmtDuration(s.duration_min)} so far`} />
            {activeMethods.map((m) => <Stat key={m.id} label={m.name} value={money(s.by_method[m.id] ?? 0)} />)}
            <Stat label="Customer debts" value={money(s.debts)} />
          </section>
          <NewSale rate={d.rate} customers={customers} onDone={reload} />
          <div className="panel">
            <div className="panel__header"><div><p>My shift</p><h2>Sales</h2></div></div>
            <SalesTable sales={d.sales} canVoid={can('void')} onVoid={setVoiding} />
          </div>
        </>
      )}
      {d && (d.live.length > 0 && (can('reports') || can('void'))) && (
        <LiveBoard live={others.length || !s ? (s ? others : d.live) : []} title={s ? 'Other open shifts' : 'Open shifts now'} onChanged={reload} />
      )}
      {closing && s && <CloseShift s={s} methods={activeMethods} onClose={() => setClosing(false)}
        onDone={async (id) => { setClosing(false); setSlip(await get(`/fuel/sessions/${id}`)); reload(); }} />}
      {slip && <ShiftSlip s={slip} onClose={() => setSlip(null)} />}
      {voiding && <ReasonModal open onClose={() => setVoiding(null)} title="Cancel this sale?" action={`/fuel/sales/${voiding.id}/void`} confirmLabel="Cancel sale"
        message={<>{money(voiding.amount)} · {voiding.method_name ?? `debt of ${voiding.customer_name}`}. The money is taken off the shift and the books.</>} onDone={reload} />}
    </div>
  );
}

function SalesTable({ sales, canVoid, onVoid }: { sales: any[]; canVoid: boolean; onVoid?: (x: any) => void }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Time</th><th className="num">Amount</th><th>Item</th><th>Received as</th><th>By</th><th></th></tr></thead>
        <tbody>
          {sales.map((x) => (
            <tr key={x.id} style={{ opacity: x.status === 'voided' ? 0.5 : 1 }}>
              <td className="small">{fmtClock(x.created_at)}</td>
              <td className="num"><strong>{money(x.amount)}</strong>{x.slsh_amount && <div className="small muted">{x.slsh_amount.toLocaleString('en-US')} SLSH</div>}</td>
              <td>{x.item_name ? <><strong>{x.item_name}</strong><div className="small muted">{num3(x.qty)} {x.item_unit}</div></> : <span className="muted">—</span>}</td>
              <td>{x.method_name ?? <>Debt: <strong>{x.customer_name}</strong></>}{x.status === 'voided' && <div><StatusBadge label="Cancelled" tone="red" /> <span className="small muted">{x.void_reason}</span></div>}</td>
              <td className="small">{x.created_by_name}</td>
              <td>{canVoid && onVoid && x.status === 'completed' && <button type="button" className="btn btn-ghost btn-xs" onClick={() => onVoid(x)}>Cancel</button>}</td>
            </tr>
          ))}
          {!sales.length && <tr><td colSpan={6} className="muted">No sales yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function OpenShift({ d, onDone, onSlip }: { d: any; onDone: () => void; onSlip: (id: string) => void }) {
  const [name, setName] = useState(d.suggested ?? d.times[0]?.name ?? '');
  const { run, busy } = useSubmit();
  const t = d.times.find((x: any) => x.name === name);
  return (
    <div className="form-stack">
      <div className="panel form-stack">
        <div className="panel__header"><div><p>Start work</p><h2>Open your shift</h2></div></div>
        <p className="small muted" style={{ margin: 0 }}>Press the button when you start. Then record every payment you collect. Close the shift when your time finishes.</p>
        <div className="form-row">
          <Field label="Shift">
            <select className="form-select" value={name} onChange={(e) => setName(e.target.value)}>
              {d.times.map((x: any) => <option key={x.name} value={x.name}>{x.name} · {x.start}–{x.end}{x.name === d.suggested ? ' (now)' : ''}</option>)}
            </select>
          </Field>
          <Field label="Hargeisa time now"><div className="cart-total" style={{ fontSize: 22 }}>{fmtClock(new Date().toISOString())}</div></Field>
        </div>
        {d.suggested && name !== d.suggested && <div className="mc-warn">Right now it is the {d.suggested} shift time. Open {name} anyway only if that is your shift.</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-primary" style={{ minHeight: 52, minWidth: 220, fontSize: 16 }} disabled={busy || !name}
            onClick={async () => { if (await run((key) => post('/fuel/open', { shiftName: name }, key), `${name} shift opened`)) onDone(); }}>
            <Play size={18} /> Open {name} shift{t ? ` (${t.start}–${t.end})` : ''}
          </button>
        </div>
      </div>
      {d.last && (
        <div className="panel">
          <div className="row row--between">
            <span className="small">Your last shift: <strong>{d.last.shift_name} #{d.last.number}</strong>, closed {fmtTime(d.last.closed_at)} — collected <strong>{money(d.last.sold)}</strong></span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSlip(d.last.id)}>View</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** An item's price in its own money, with the other money beside it when there is a rate. */
export function priceText(it: { price: number; currency: string }, rate?: number | null) {
  const own = it.currency === 'USD' ? money(it.price) : `${it.price.toLocaleString('en-US')} SLSH`;
  if (!rate) return own;
  const other = it.currency === 'USD' ? `${Math.round((it.price / 100) * rate).toLocaleString('en-US')} SLSH` : money(Math.round((it.price / rate) * 100));
  return `${own} (≈ ${other})`;
}
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function NewSale({ rate, customers, onDone }: { rate: number | null; customers: { data: any; reload: () => void }; onDone: () => void }) {
  const { activeMethods, can } = useAuth();
  const items = useLoad(() => get('/fuel/items'), []);
  const list: any[] = (items.data ?? []).filter((i: any) => i.active);
  const [itemId, setItemId] = useState('');
  const [by, setBy] = useState<'qty' | 'amount'>('qty');
  const [value, setValue] = useState('');
  const [method, setMethod] = useState('cash');   // a payment method id, or 'debt'
  const [customer, setCustomer] = useState('');
  const [find, setFind] = useState('');
  const { run, busy } = useSubmit();
  const item = list.find((i) => i.id === itemId) ?? (list.length === 1 ? list[0] : null);

  // Before the manager adds items, a sale can still be a plain amount in dollars.
  const plain = items.data !== undefined && items.data !== null && list.length === 0;
  let total = 0;   // in the item's own money (cents for USD, shillings for SLSH)
  let qty = 0;
  if (plain) { total = toCents(value); }
  else if (item && value) {
    if (by === 'qty') { qty = round3(Number(value) || 0); total = Math.round(qty * item.price); }
    else { total = item.currency === 'USD' ? toCents(value) : Math.round(Number(value) || 0); qty = round3(total / item.price); }
  }
  const usd = plain ? total : !item || !total ? 0 : item.currency === 'USD' ? total : rate ? Math.round((total / rate) * 100) : 0;
  const slshValue = !total ? null : plain ? slsh(usd, rate) : item?.currency === 'SLSH' ? `${total.toLocaleString('en-US')} SLSH` : slsh(usd, rate);
  const needRate = Boolean(item && item.currency === 'SLSH' && !rate);
  const short = Boolean(item?.track_stock && qty > item.stock_qty);
  const ok = total > 0 && usd > 0 && !needRate && (plain || item) && (method !== 'debt' || customer);
  const shown = list.filter((i) => !find.trim() || `${i.name} ${i.category}`.toLowerCase().includes(find.trim().toLowerCase()));

  const save = async () => {
    if (!ok || busy) return;
    const who = method === 'debt' ? { customer } : { method };
    const what = plain ? { amount: total } : { item: item.id, ...(by === 'qty' ? { qty } : { amount: total }) };
    if (await run((key) => post('/fuel/sales', { ...who, ...what }, key), `${money(usd)} recorded`)) { setValue(''); setCustomer(''); onDone(); items.reload(); }
  };

  return (
    <div className="panel form-stack">
      <div className="panel__header"><div><p>New</p><h2>Record a sale</h2></div></div>
      {plain && <div className="mc-note">No items yet. {can('catalog') ? 'Add them in Inventory so prices are set for everyone.' : 'The manager must add the items and prices in Inventory.'} Until then you can record an amount.</div>}
      {!plain && (
        <>
          {list.length > 8 && <input className="form-input" type="search" placeholder="Search item" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search item" />}
          <div className="item-grid">
            {shown.map((i) => (
              <button key={i.id} type="button" className={`item-tile ${item?.id === i.id ? 'item-tile--on' : ''}`} onClick={() => { setItemId(i.id); setValue(''); }}>
                <strong>{i.name}</strong><span>{priceText(i, null)} / {i.unit}</span>
              </button>
            ))}
            {!shown.length && <span className="muted">No item matches.</span>}
          </div>
        </>
      )}
      {!plain && item && (
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className={`btn btn-sm ${by === 'qty' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setBy('qty'); setValue(''); }}>By quantity ({item.unit})</button>
          <button type="button" className={`btn btn-sm ${by === 'amount' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setBy('amount'); setValue(''); }}>By amount ({item.currency === 'USD' ? '$' : 'SLSH'})</button>
        </div>
      )}
      {(plain || item) && (
        <Field label={plain ? 'Amount (USD)' : by === 'qty' ? `How many ${item.unit}` : `Amount (${item.currency === 'USD' ? 'USD' : 'SLSH'})`}>
          <input className="form-input" inputMode="decimal" style={{ fontSize: 22, minHeight: 52 }} value={value} placeholder={by === 'qty' && !plain ? '0' : item?.currency === 'SLSH' ? '0' : '0.00'}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
        </Field>
      )}
      {total > 0 && (
        <div className="cart-total"><span>{!plain && item ? `${num3(qty)} ${item.unit} × ${priceText(item, null)}` : 'Total'}</span>
          <span>{usd > 0 ? money(usd) : '—'}{slshValue && <span className="small muted"> · {slshValue}</span>}</span></div>
      )}
      {needRate && <div className="mc-error">This item is priced in Shillings and there is no exchange rate yet. Ask the manager to set it (Settings).</div>}
      {short && <div className="mc-warn">Only {num3(item.stock_qty)} {item.unit} of {item.name} in stock. You can still record it; tell the manager to check the stock.</div>}
      <div className="method-picker">
        {activeMethods.map((m) => <button key={m.id} type="button" className={`btn ${method === m.id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMethod(m.id)}>{m.name}</button>)}
        <button type="button" className={`btn ${method === 'debt' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMethod('debt')}>Customer debt</button>
      </div>
      {method === 'debt' && (
        <>
          <PartySelect kind="customers" value={customer} items={customers.data ?? []} placeholder="Choose the customer…" onCreated={customers.reload} onChange={setCustomer} />
          <p className="small muted" style={{ margin: 0 }}>The customer must be in the list. Use “+ New” to add one first.</p>
        </>
      )}
      <div className="form-actions"><button type="button" className="btn btn-primary" style={{ minHeight: 52, minWidth: 220 }} disabled={!ok || busy} onClick={save}>Record {usd > 0 ? money(usd) : 'sale'}</button></div>
    </div>
  );
}
const num3 = (n: number) => Number(n.toFixed(3)).toLocaleString('en-US');

function CloseShift({ s, methods, onClose, onDone }: { s: any; methods: { id: string; name: string }[]; onClose: () => void; onDone: (id: string) => void }) {
  const [note, setNote] = useState('');
  const { run, busy } = useSubmit();
  return (
    <Modal open onClose={onClose} title={`Close ${s.shift_name} shift #${s.number}`} width="md"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Back</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run((key) => post('/fuel/close', { note }, key), 'Shift closed'); if (r) onDone(r.id); }}>Close shift</button></>}>
      <div className="form-stack">
        <p className="small muted" style={{ margin: 0 }}>Worked {fmtClock(s.opened_at)} – now ({fmtDuration(s.duration_min)}) · {s.count} sales. Check that this is what you collected:</p>
        <Collected s={s} methods={methods} />
        <Field label="Note for the owner (optional)"><input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. pump 2 was broken in the afternoon" /></Field>
        <div className="mc-note">After you close, you cannot add sales to this shift. Open a new shift when you start again.</div>
      </div>
    </Modal>
  );
}

/** Everyone's open shifts right now (managers and the owner). A manager can close a forgotten one. */
function LiveBoard({ live, title, onChanged }: { live: any[]; title: string; onChanged: () => void }) {
  const { can, activeMethods } = useAuth();
  const [closing, setClosing] = useState<any>(null);
  const { run, busy } = useSubmit();
  if (!live.length) return null;
  return (
    <div className="panel">
      <div className="panel__header"><div><p>Live · Hargeisa time</p><h2>{title}</h2></div></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Salesman</th><th>Shift</th><th>Opened</th><th className="num">Collected</th>{activeMethods.map((m) => <th key={m.id} className="num">{m.name}</th>)}<th className="num">Debts</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {live.map((x) => (
              <tr key={x.id}>
                <td><strong>{x.user_name}</strong></td><td>{x.shift_name} #{x.number}</td>
                <td className="small">{fmtClock(x.opened_at)}<div className="muted">{fmtDuration(x.duration_min)}</div></td>
                <td className="num"><strong>{money(x.sold)}</strong><div className="small muted">{x.count} sales</div></td>
                {activeMethods.map((m) => <td key={m.id} className="num">{money(x.by_method[m.id] ?? 0)}</td>)}
                <td className="num">{money(x.debts)}</td><td><ShiftBadge s={x} /></td>
                <td>{can('void') && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setClosing(x)}>Close</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {closing && (
        <Modal open onClose={() => setClosing(null)} title={`Close ${closing.user_name}'s shift?`} width="sm"
          footer={<><button type="button" className="btn btn-secondary" onClick={() => setClosing(null)}>Back</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { if (await run((key) => post('/fuel/close', { shiftId: closing.id, note: 'Closed by the manager' }, key), 'Shift closed')) { setClosing(null); onChanged(); } }}>Close shift</button></>}>
          <p>{closing.user_name} has collected {money(closing.sold)} in this {closing.shift_name} shift. Closing it stops new sales from being added to it. Use this when they forgot to close.</p>
        </Modal>
      )}
    </div>
  );
}

/** A shift with all its sales: printable. */
function ShiftSlip({ s, onClose }: { s: any; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={`${s.shift_name} shift #${s.number} · ${s.user_name}`} width="lg"
      footer={<button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print</button>}>
      <div className="print-area form-stack">
        <img className="print-only print-logo" src="/logo-full.svg" alt="Meecaad" />
        <h3 style={{ margin: 0 }}>Meecaad Fuel Station — {s.shift_name} shift #{s.number}</h3>
        <p className="small" style={{ margin: 0 }}>
          {s.user_name} · opened {fmtTime(s.opened_at)}{s.closed_at ? ` · closed ${fmtTime(s.closed_at)}${s.closed_by_name && s.closed_by_name !== s.user_name ? ` by ${s.closed_by_name}` : ''}` : ' · still open'} (Hargeisa time) · {fmtDuration(s.duration_min)}
        </p>
        <Collected s={s} methods={s.methods} />
        {s.note && <p style={{ margin: 0 }}><strong>Note:</strong> {s.note}</p>}
        <SalesTable sales={s.sales} canVoid={false} />
      </div>
    </Modal>
  );
}

// ── Shifts ──────────────────────────────────────────────────────
export function FuelShiftsPage() {
  const { today, can } = useAuth();
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const list = useLoad(() => get('/fuel/sessions', { from, to }), [from, to]);
  usePolling(list.reload, 30000);
  const [slip, setSlip] = useState<any>(null);
  const methods: { id: string; name: string }[] = list.data?.methods ?? [];
  const filter = useFilters<any>(list.data?.shifts ?? [], [
    { key: 'who', label: 'Salesman', get: (s) => s.user_name },
    { key: 'shift', label: 'Shift', get: (s) => s.shift_name },
    { key: 'status', label: 'Status', get: (s) => (s.status === 'closed' ? 'Closed' : s.overdue ? 'Overdue' : 'Open') },
  ]);
  return (
    <div className="module-page">
      <PageHeader icon={<History size={22} />} title="Shifts" subtitle={can('reports') ? 'Every salesman\'s shifts: when, and how much was collected (Hargeisa time)' : 'Your shifts'} />
      <div className="panel">
        <div style={{ marginBottom: 12 }}><DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} /></div>
        <ErrorBox error={list.error} />
        {filter.bar}
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Salesman</th><th>Shift</th><th>Time</th><th className="num">Collected</th>{methods.map((m) => <th key={m.id} className="num">{m.name}</th>)}<th className="num">Debts</th><th>Status</th></tr></thead>
            <tbody>
              {filter.shown.map((s: any) => (
                <tr key={s.id} className="tr--clickable" onClick={async () => setSlip(await get(`/fuel/sessions/${s.id}`))}>
                  <td><strong>{s.number}</strong></td>
                  <td>{s.user_name}</td>
                  <td>{s.shift_name}<div className="small muted">{s.entry_date}</div></td>
                  <td className="small">{fmtClock(s.opened_at)} – {s.closed_at ? fmtClock(s.closed_at) : 'now'}<div className="muted">{fmtDuration(s.duration_min)}</div></td>
                  <td className="num"><strong>{money(s.sold)}</strong><div className="small muted">{s.count} sales</div></td>
                  {methods.map((m) => <td key={m.id} className="num">{money(s.by_method[m.id] ?? 0)}</td>)}
                  <td className="num">{money(s.debts)}</td>
                  <td><ShiftBadge s={s} /></td>
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

// ── Dashboard: what is happening, and numbers for decisions ─────
export function FuelDashboard() {
  const { today, path, activeMethods } = useAuth();
  const navigate = useNavigate();
  const cur = useLoad(() => get('/fuel/current'), []);
  const sum = useLoad(() => get('/fuel/summary', { from: addDays(today, -6), to: today }), [today]);
  const dash = useLoad(() => get('/dashboard', { business: 'fuel' }), []);
  const cust = useLoad(() => get('/customers', { business: 'fuel' }), []);
  const stockList = useLoad(() => get('/fuel/items'), []);
  const reload = () => { cur.reload(); sum.reload(); dash.reload(); cust.reload(); stockList.reload(); };
  usePolling(reload, 30000);
  if (!cur.data || !sum.data || !dash.data) return cur.error || sum.error || dash.error ? <ErrorBox error={cur.error || sum.error || dash.error} /> : <PageSkeleton />;

  const rate = cur.data.rate;
  const S = sum.data;
  const day = (date: string) => S.days.find((x: any) => x.date === date) ?? { sold: 0, debts: 0, count: 0, shifts: 0, by_method: {} };
  const t = day(today), y = day(addDays(today, -1));
  const live = cur.data.live as any[];
  const overdue = live.filter((x) => x.overdue).length;
  const owed = (cust.data ?? []).filter((c: any) => c.balance > 0).sort((a: any, b: any) => b.balance - a.balance);
  const owedTotal = owed.reduce((s: number, c: any) => s + c.balance, 0);
  const balances = dash.data.cash.filter((c: any) => c.business_id === 'fuel');
  const alerts = dash.data.alerts.filter((a: any) => a.business === 'fuel').slice(0, 6);
  const maxDay = Math.max(1, ...S.days.map((x: any) => x.sold));
  const topPerson = S.people[0], topShift = S.by_shift[0];
  const creditShare = S.total.sold ? Math.round((S.total.debts / S.total.sold) * 100) : 0;

  // Plain sentences to help decisions.
  const insights: string[] = [];
  const wk = pct(S.total.sold, S.previous.sold);
  if (wk !== null) insights.push(`Sales in the last 7 days are ${money(S.total.sold)} — ${wk >= 0 ? `up ${wk}%` : `down ${Math.abs(wk)}%`} compared with the 7 days before (${money(S.previous.sold)}).`);
  if (topShift && S.by_shift.length > 1) insights.push(`The ${topShift.name} shift sells the most: ${money(topShift.average)} per shift on average.`);
  if (topPerson && S.people.length > 1) insights.push(`${topPerson.name} collected the most this week: ${money(topPerson.sold)} in ${topPerson.shifts} ${topPerson.shifts === 1 ? 'shift' : 'shifts'}.`);
  if (creditShare >= 15) insights.push(`${creditShare}% of this week's sales were given on credit. Customers owe ${money(owedTotal)} in total — collect before giving more.`);
  else if (owedTotal > 0) insights.push(`Customers owe ${money(owedTotal)}. Credit is ${creditShare}% of this week's sales.`);
  if (overdue) insights.push(`${overdue} ${overdue === 1 ? 'shift is' : 'shifts are'} open past the set time — ask the salesman to close.`);

  return (
    <div className="dashboard">
      <PageHeader icon={<Home size={22} />} title="Fuel station dashboard" subtitle={`${dash.data.today} · Hargeisa time`}
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={reload}><RefreshCw size={14} /> Refresh</button>} />

      <section className="stat-grid">
        <Stat label="Sales today" value={money(t.sold)} sub={<><Trend now={t.sold} before={y.sold} label="yesterday" />{slsh(t.sold, rate) && <div className="small muted">{slsh(t.sold, rate)}</div>}</>} />
        <button type="button" className="stat stat--link" onClick={() => navigate(path('/shifts'))}>
          <span className="stat__label">Shifts open now</span><strong className="stat__value">{live.length}</strong>
          <span className="stat__sub">{live.length ? live.map((x) => x.user_name.split(' ')[0]).join(', ') : 'nobody is working'}{overdue ? ` · ${overdue} overdue` : ''}</span>
        </button>
        <button type="button" className="stat stat--link" onClick={() => navigate(path('/customers'))}>
          <span className="stat__label">Customers owe</span><strong className="stat__value">{money(owedTotal)}</strong>
          <span className="stat__sub">{owed.length} {owed.length === 1 ? 'customer' : 'customers'} · open Credit Customers →</span>
        </button>
        <Stat label="Average per shift (7 days)" value={money(S.shifts ? Math.round(S.total.sold / S.shifts) : 0)} sub={`${S.shifts} shifts · ${rate ? rateText(rate) : 'set the exchange rate in Settings'}`} />
      </section>

      {insights.length > 0 && (
        <div className="panel">
          <div className="panel__header"><div><p>In plain words</p><h2><Lightbulb size={16} style={{ verticalAlign: -2 }} /> What the numbers say</h2></div></div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>{insights.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}

      {live.length > 0 && <LiveBoard live={live} title="Working now" onChanged={reload} />}
      {!live.length && <div className="mc-note"><Clock size={14} style={{ verticalAlign: -2 }} /> No shift is open right now.</div>}
      {alerts.length > 0 && (
        <div className="panel">
          <div className="panel__header"><div><p>Needs attention</p><h2>Alerts</h2></div></div>
          <div className="form-stack">{alerts.map((a: any, i: number) => <div key={i} className={a.level === 'red' ? 'mc-error' : 'mc-warn'}><strong>{a.title}</strong><div className="small">{a.detail}</div></div>)}</div>
        </div>
      )}

      <div className="grid-2">
        <div className="panel">
          <div className="panel__header"><div><p>Today</p><h2>How the money came in</h2></div></div>
          <div className="form-stack">
            {[...activeMethods.map((m) => ({ key: m.id, name: m.name, v: t.by_method[m.id] ?? 0 })), { key: 'debt', name: 'Customer debts', v: t.debts }].map((x) => (
              <div key={x.key}><div className="row row--between small"><span>{x.name}</span><span><strong>{money(x.v)}</strong>{t.sold ? ` · ${Math.round((x.v / t.sold) * 100)}%` : ''}</span></div><Bar value={x.v} max={t.sold} /></div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel__header"><div><p>Balances</p><h2>Money held</h2></div></div>
          <div className="kv">
            {balances.map((b: any) => <Fragment key={b.method_id}><span>{b.method_name}</span><span>{money(b.balance)}</span></Fragment>)}
            <span className="kv-total">Total</span><span className="kv-total">{money(balances.reduce((s: number, b: any) => s + b.balance, 0))}</span>
          </div>
          {owed.length > 0 && <>
            <p className="small muted" style={{ margin: '12px 0 4px' }}>Who owes the most</p>
            <div className="kv">{owed.slice(0, 3).map((c: any) => <Fragment key={c.id}><span>{c.name}</span><span>{money(c.balance)}</span></Fragment>)}</div>
          </>}
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel__header"><div><p>Last 7 days</p><h2>Who sold</h2></div></div>
          <div className="form-stack">
            {S.people.map((p: any) => (
              <div key={p.key}><div className="row row--between small"><span><strong>{p.name}</strong> · {p.shifts} {p.shifts === 1 ? 'shift' : 'shifts'}</span><span><strong>{money(p.sold)}</strong> · {money(p.average)}/shift</span></div><Bar value={p.sold} max={S.people[0]?.sold ?? 0} /></div>
            ))}
            {!S.people.length && <span className="muted">No sales yet.</span>}
          </div>
        </div>
        <div className="panel">
          <div className="panel__header"><div><p>Last 7 days</p><h2>Which shift sells</h2></div></div>
          <div className="form-stack">
            {S.by_shift.map((p: any) => (
              <div key={p.key}><div className="row row--between small"><span><strong>{p.name}</strong> · {p.shifts} {p.shifts === 1 ? 'shift' : 'shifts'}</span><span><strong>{money(p.sold)}</strong> · {money(p.average)}/shift</span></div><Bar value={p.average} max={Math.max(1, ...S.by_shift.map((x: any) => x.average))} tone="#0ea5e9" /></div>
            ))}
            {!S.by_shift.length && <span className="muted">No sales yet.</span>}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel__header"><div><p>Last 7 days</p><h2>What sells</h2></div></div>
          <div className="form-stack">
            {S.by_item.map((p: any) => (
              <div key={p.name}><div className="row row--between small"><span><strong>{p.name}</strong>{p.unit ? ` · ${num3(p.qty)} ${p.unit}` : ''}</span><span><strong>{money(p.amount)}</strong>{S.total.sold ? ` · ${Math.round((p.amount / S.total.sold) * 100)}%` : ''}</span></div>
                <Bar value={p.amount} max={S.by_item[0]?.amount ?? 0} tone="#f59e0b" /></div>
            ))}
            {!S.by_item.length && <span className="muted">No sales yet.</span>}
          </div>
        </div>
        <div className="panel">
          <div className="panel__header"><div><p>Now</p><h2>Stock</h2></div><button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(path('/inventory'))}>Inventory →</button></div>
          <div className="kv">
            {(stockList.data ?? []).filter((i: any) => i.active && i.track_stock).slice(0, 8).map((i: any) => (
              <Fragment key={i.id}><span>{i.name}</span><span style={{ color: i.stock_qty <= 0 || (i.reorder_level > 0 && i.stock_qty <= i.reorder_level) ? '#b91c1c' : undefined }}>{num3(i.stock_qty)} {i.unit}</span></Fragment>
            ))}
          </div>
          {!(stockList.data ?? []).some((i: any) => i.active && i.track_stock) && <span className="muted">No items with tracked stock yet. Add them in Inventory.</span>}
        </div>
      </div>

      <div className="panel">
        <div className="panel__header"><div><p>Last 7 days</p><h2>Day by day</h2></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th className="num">Shifts</th><th>Sold</th>{activeMethods.map((m) => <th key={m.id} className="num">{m.name}</th>)}<th className="num">Debts</th></tr></thead>
            <tbody>
              {S.days.map((x: any) => (
                <tr key={x.date}><td>{x.date}</td><td className="num">{x.shifts}</td>
                  <td style={{ minWidth: 150 }}><strong>{money(x.sold)}</strong><Bar value={x.sold} max={maxDay} /></td>
                  {activeMethods.map((m) => <td key={m.id} className="num">{money(x.by_method[m.id] ?? 0)}</td>)}<td className="num">{money(x.debts)}</td></tr>
              ))}
              {!S.days.length && <tr><td colSpan={activeMethods.length + 4} className="muted">No sales in the last 7 days.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Reports ─────────────────────────────────────────────────────
export function FuelReports() {
  const { today, activeMethods } = useAuth();
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const r = useLoad(() => get('/fuel/summary', { from, to }), [from, to]);
  const S = r.data;
  const hasRate = Boolean(S?.rates?.length);
  const slshTotal = (S?.days ?? []).reduce((t: number, d: any) => t + Math.round((d.sold / 100) * (rateOn(S.rates, d.date) ?? 0)), 0);
  const cell = (x: any, id: string) => <td key={id} className="num">{money(x.by_method[id] ?? 0)}</td>;
  return (
    <div className="module-page">
      <PageHeader icon={<BarChart3 size={22} />} title="Reports" subtitle={`${from} to ${to} · Hargeisa time`}
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button>} />
      <div className="no-print"><DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} /></div>
      <ErrorBox error={r.error} />
      {S && (
        <div className="print-area form-stack">
          <img className="print-only print-logo" src="/logo-full.svg" alt="Meecaad" />
          <h3 className="print-only">Meecaad Fuel Station — sales report {from} to {to}</h3>
          <section className="stat-grid">
            <Stat label="Collected" value={money(S.total.sold)} sub={<>{hasRate && `${slshTotal.toLocaleString('en-US')} SLSH · `}<Trend now={S.total.sold} before={S.previous.sold} label="the period before" /></>} />
            <Stat label="Shifts" value={String(S.shifts)} sub={S.shifts ? `${money(Math.round(S.total.sold / S.shifts))} per shift` : '—'} />
            <Stat label="Received (cash, Zaad, Edahab)" value={money(S.total.sold - S.total.debts)} sub={activeMethods.map((m) => `${m.name} ${money(S.days.reduce((t: number, d: any) => t + (d.by_method[m.id] ?? 0), 0))}`).join(' · ')} />
            <Stat label="Given on credit" value={money(S.total.debts)} sub={S.total.sold ? `${Math.round((S.total.debts / S.total.sold) * 100)}% of sales` : '—'} />
          </section>

          <div className="panel"><div className="panel__header"><div><p>By day</p><h2>Daily reconciliation</h2></div></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th className="num">Shifts</th><th className="num">Collected</th>{hasRate && <th className="num">SLSH</th>}{activeMethods.map((m) => <th key={m.id} className="num">{m.name}</th>)}<th className="num">Debts</th></tr></thead>
                <tbody>
                  {S.days.map((x: any) => {
                    const rate = rateOn(S.rates, x.date);
                    return (
                      <tr key={x.date}><td>{x.date}{rate && <div className="small muted">{rate.toLocaleString('en-US')} SLSH/$</div>}</td><td className="num">{x.shifts}</td><td className="num"><strong>{money(x.sold)}</strong></td>
                        {hasRate && <td className="num">{rate ? Math.round((x.sold / 100) * rate).toLocaleString('en-US') : '—'}</td>}
                        {activeMethods.map((m) => cell(x, m.id))}<td className="num">{money(x.debts)}</td></tr>
                    );
                  })}
                  {!S.days.length && <tr><td colSpan={activeMethods.length + 5} className="muted">No sales in this period.</td></tr>}
                  {S.days.length > 0 && (
                    <tr><td><strong>Total</strong></td><td className="num"><strong>{S.days.reduce((t: number, d: any) => t + d.shifts, 0)}</strong></td><td className="num"><strong>{money(S.total.sold)}</strong></td>
                      {hasRate && <td className="num"><strong>{slshTotal.toLocaleString('en-US')}</strong></td>}
                      {activeMethods.map((m) => <td key={m.id} className="num"><strong>{money(S.days.reduce((t: number, d: any) => t + (d.by_method[m.id] ?? 0), 0))}</strong></td>)}
                      <td className="num"><strong>{money(S.total.debts)}</strong></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel"><div className="panel__header"><div><p>By item</p><h2>What was sold</h2></div></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Item</th><th className="num">Quantity</th><th className="num">Sales</th><th className="num">Cost of goods</th><th className="num">Profit on goods</th><th className="num">Share</th></tr></thead>
              <tbody>{S.by_item.map((p: any) => <tr key={p.name}><td><strong>{p.name}</strong></td><td className="num">{p.unit ? `${num3(p.qty)} ${p.unit}` : '—'}</td><td className="num"><strong>{money(p.amount)}</strong></td>
                  <td className="num">{p.cost ? money(p.cost) : <span className="muted">—</span>}</td><td className="num" style={{ color: p.amount - p.cost < 0 ? '#b91c1c' : '#15803d' }}>{p.cost ? money(p.amount - p.cost) : <span className="muted">—</span>}</td>
                  <td className="num">{S.total.sold ? `${Math.round((p.amount / S.total.sold) * 100)}%` : '—'}</td></tr>)}
                {!S.by_item.length && <tr><td colSpan={6} className="muted">No sales.</td></tr>}</tbody>
            </table></div>
          </div>

          <div className="grid-2">
            <div className="panel"><div className="panel__header"><div><p>By salesman</p><h2>Who sold</h2></div></div>
              <div className="table-wrap"><table>
                <thead><tr><th>Salesman</th><th className="num">Shifts</th><th className="num">Collected</th><th className="num">Per shift</th><th className="num">Debts</th></tr></thead>
                <tbody>{S.people.map((p: any) => <tr key={p.key}><td><strong>{p.name}</strong></td><td className="num">{p.shifts}</td><td className="num"><strong>{money(p.sold)}</strong></td><td className="num">{money(p.average)}</td><td className="num">{money(p.debts)}</td></tr>)}
                  {!S.people.length && <tr><td colSpan={5} className="muted">No sales.</td></tr>}</tbody>
              </table></div>
            </div>
            <div className="panel"><div className="panel__header"><div><p>By shift</p><h2>Morning, evening, night</h2></div></div>
              <div className="table-wrap"><table>
                <thead><tr><th>Shift</th><th className="num">Shifts</th><th className="num">Collected</th><th className="num">Per shift</th><th className="num">Debts</th></tr></thead>
                <tbody>{S.by_shift.map((p: any) => <tr key={p.key}><td><strong>{p.name}</strong></td><td className="num">{p.shifts}</td><td className="num"><strong>{money(p.sold)}</strong></td><td className="num">{money(p.average)}</td><td className="num">{money(p.debts)}</td></tr>)}
                  {!S.by_shift.length && <tr><td colSpan={5} className="muted">No sales.</td></tr>}</tbody>
              </table></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────
export function FuelSettings() {
  const [tab, setTab] = useState('rate');
  return (
    <div className="module-page">
      <PageHeader icon={<Settings size={22} />} title="Settings" subtitle="Exchange rate, shift times and expense categories" />
      <div className="panel" style={{ paddingBottom: 0 }}><Tabs tabs={[{ key: 'rate', label: 'Exchange rate' }, { key: 'times', label: 'Shift times' }, { key: 'cats', label: 'Expense categories' }]} activeTab={tab} onTabChange={setTab} /></div>
      {tab === 'rate' ? <RateSettings /> : tab === 'times' ? <ShiftTimes /> : <ExpenseCategories business="fuel" />}
    </div>
  );
}

/** Expense categories registered in advance; expenses are chosen from this list. */
function ExpenseCategories({ business }: { business: string }) {
  const list = useLoad(() => get('/expense-categories', { business }), [business]);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const { run, busy } = useSubmit();
  const add = async () => { if (await run((key) => post('/expense-categories', { business, name }, key), 'Category added')) { setName(''); list.reload(); } };
  const change = async (id: string, body: object, msg: string) => { if (await run(() => patch(`/expense-categories/${id}`, body), msg)) { setRenaming(null); list.reload(); } };
  return (
    <div className="panel form-stack">
      <div className="panel__header"><div><p>Expenses</p><h2>Expense categories</h2></div></div>
      <p className="small muted" style={{ margin: 0 }}>Everyone recording an expense chooses one of these. Hidden categories are no longer offered; past expenses keep their category.</p>
      <div className="row" style={{ gap: 8 }}>
        <input className="form-input" style={{ flex: '1 1 220px', maxWidth: 360 }} value={name} placeholder="New category, e.g. Security guard" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) add(); }} />
        <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={add}>Add category</button>
      </div>
      <ErrorBox error={list.error} />
      <div className="table-wrap">
        <table>
          <tbody>
            {(list.data ?? []).map((c: any) => (
              <tr key={c.id} style={{ opacity: c.active ? 1 : 0.55 }}>
                <td>{renaming && renaming.id === c.id
                  ? <input className="form-input" value={renaming.name} autoFocus onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && renaming.name.trim()) change(c.id, { name: renaming.name }, 'Renamed'); }} />
                  : <strong>{c.name}</strong>}{!c.active && <span className="small muted"> (hidden)</span>}</td>
                <td style={{ textAlign: 'right' }}>
                  {renaming && renaming.id === c.id
                    ? <><button type="button" className="btn btn-ghost btn-xs" onClick={() => setRenaming(null)}>Cancel</button><button type="button" className="btn btn-primary btn-xs" disabled={busy || !renaming.name.trim()} onClick={() => change(c.id, { name: renaming.name }, 'Renamed')}>Save</button></>
                    : <><button type="button" className="btn btn-ghost btn-xs" onClick={() => setRenaming({ id: c.id, name: c.name })}>Rename</button>
                      <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => change(c.id, { active: !c.active }, c.active ? 'Hidden' : 'Shown again')}>{c.active ? 'Hide' : 'Show'}</button></>}
                </td>
              </tr>
            ))}
            {!list.loading && !list.data?.length && <tr><td className="muted">No categories yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ShiftTimes() {
  const t = useLoad(() => get('/fuel/shift-times'), []);
  const [rows, setRows] = useState<{ name: string; start: string; end: string }[] | null>(null);
  const list = rows ?? t.data?.times ?? [];
  const { run, busy } = useSubmit();
  const set = (i: number, patch: object) => setRows(list.map((r: any, j: number) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="panel form-stack">
      <div className="panel__header"><div><p>Hargeisa time</p><h2>When each shift works</h2></div></div>
      <p className="small muted" style={{ margin: 0 }}>When a salesman opens a shift, the shift whose time it is now is chosen. A shift still open after its end time is shown in red to the owner. A night shift can finish the next morning (e.g. 22:00 to 06:00).</p>
      <ErrorBox error={t.error} />
      <div className="form-stack">
        {list.map((r: any, i: number) => (
          <div key={i} className="role-row" style={{ gridTemplateColumns: '1fr 130px 130px auto' }}>
            <input className="form-input" value={r.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Shift name" />
            <input className="form-input" type="time" value={r.start} onChange={(e) => set(i, { start: e.target.value })} aria-label={`${r.name} starts`} />
            <input className="form-input" type="time" value={r.end} onChange={(e) => set(i, { end: e.target.value })} aria-label={`${r.name} ends`} />
            <button type="button" className="btn btn-ghost btn-xs" disabled={list.length < 2} onClick={() => setRows(list.filter((_: any, j: number) => j !== i))} aria-label="Remove">✕</button>
          </div>
        ))}
      </div>
      <div className="row row--between">
        <button type="button" className="btn btn-ghost btn-sm" disabled={list.length >= 6} onClick={() => setRows([...list, { name: '', start: '08:00', end: '16:00' }])}>+ Add a shift</button>
        <button type="button" className="btn btn-primary" disabled={busy || rows === null || list.some((r: any) => !r.name.trim())}
          onClick={async () => { if (await run((key) => post('/fuel/shift-times', { times: list }, key), 'Shift times saved')) { setRows(null); t.reload(); } }}>Save shift times</button>
      </div>
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
