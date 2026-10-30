import { Fragment, useEffect, useState } from 'react';
import { Fuel, Printer, Plus } from 'lucide-react';
import { get, money, num, patch, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { Tabs } from '../components/Tabs';
import { DateRange, ErrorBox, Field, Money, MoneyInput, PageHeader, PartySelect, PaymentsEditor, ReasonModal, Stat, addDays, fmtTime, useLoad, useSubmit, type PayLine } from '../components/ui';

export function FuelPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState(can('fuel') ? 'shift' : 'reconcile');
  const setup = useLoad(() => get('/fuel/setup'), []);
  const tabs = [
    ...(can('fuel') ? [{ key: 'shift', label: 'Record shift readings' }] : []),
    { key: 'shifts', label: 'Shifts' },
    ...(can('fuel') ? [{ key: 'dips', label: 'Tank dips' }] : []),
    { key: 'reconcile', label: 'Fuel reconciliation' },
    ...(can('catalog') ? [{ key: 'setup', label: 'Tanks & pumps' }] : []),
  ];
  const tanks = setup.data?.tanks ?? [];
  return (
    <div className="module-page">
      <PageHeader icon={<Fuel size={22} />} title="Fuel station" subtitle="Pump meters → litres sold → money expected. Tank dips → fuel actually left." />
      <section className="stat-grid">
        {tanks.filter((t: any) => t.active).map((t: any) => (
          <Stat key={t.id} label={`${t.name} · ${t.fuel_name}`} value={`${num(t.stock_qty)} L`} tone={t.stock_qty < 0 ? 'red' : undefined}
            sub={`${t.capacity ? `${Math.round((t.stock_qty / t.capacity) * 100)}% of ${num(t.capacity)} L · ` : ''}${money(t.sale_price)}/L`} />
        ))}
      </section>
      <ErrorBox error={setup.error} />
      <div className="panel">
        <Tabs tabs={tabs} activeTab={tab} onTabChange={setTab} />
        {tab === 'shift' && <ShiftForm setup={setup.data} onSaved={() => { setup.reload(); setTab('shifts'); }} />}
        {tab === 'shifts' && <ShiftList onChange={setup.reload} />}
        {tab === 'dips' && <Dips tanks={tanks} onSaved={setup.reload} />}
        {tab === 'reconcile' && <Reconciliation />}
        {tab === 'setup' && <Setup data={setup.data} onChange={setup.reload} />}
      </div>
    </div>
  );
}

function ShiftForm({ setup, onSaved }: { setup: any; onSaved: () => void }) {
  const { today } = useAuth();
  const pumps = (setup?.pumps ?? []).filter((p: any) => p.active);
  const customers = useLoad(() => get('/customers', { business: 'fuel' }), []);
  const [date, setDate] = useState(today);
  const [shiftName, setShiftName] = useState('Day');
  const [closing, setClosing] = useState<Record<string, string>>({});
  const [opening, setOpening] = useState<Record<string, string>>({});
  const [payments, setPayments] = useState<PayLine[]>([{ method: 'cash', amount: '' }, { method: 'zaad', amount: '' }, { method: 'edahab', amount: '' }]);
  const [credits, setCredits] = useState<{ customer: string; amount: string }[]>([]);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const { run, busy } = useSubmit();

  useEffect(() => { setOpening(Object.fromEntries(pumps.map((p: any) => [p.id, String(p.last_meter)]))); }, [setup]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = pumps.map((p: any) => {
    const o = Number(opening[p.id] ?? p.last_meter);
    const c = closing[p.id] === undefined || closing[p.id] === '' ? null : Number(closing[p.id]);
    const liters = c === null ? 0 : Math.round((c - o) * 1000) / 1000;
    return { p, o, c, liters, amount: Math.round(Math.max(liters, 0) * p.sale_price), bad: c !== null && c < o, gap: Math.abs(o - p.last_meter) > 0.0005 };
  });
  const entered = rows.filter((r: any) => r.c !== null);
  const expected = entered.reduce((s: number, r: any) => s + r.amount, 0);
  const liters = entered.reduce((s: number, r: any) => s + r.liters, 0);
  const collected = payments.reduce((s, p) => s + toCents(p.amount), 0);
  const credit = credits.reduce((s, c) => s + toCents(c.amount), 0);
  const diff = collected + credit - expected;

  const save = async () => {
    const r = await run((key) => post('/fuel/shifts', {
      date, shiftName, note, differenceReason: reason,
      readings: entered.map((r: any) => ({ pump: r.p.id, opening: r.o, closing: r.c })),
      payments: payments.map((p) => ({ method: p.method, amount: toCents(p.amount) })),
      credits: credits.map((c) => ({ customer: c.customer, amount: toCents(c.amount) })),
    }, key), 'Shift saved');
    if (r) { setClosing({}); setCredits([]); setReason(''); setNote(''); setPayments(payments.map((p) => ({ ...p, amount: '' }))); onSaved(); }
  };

  if (!pumps.length) return <div className="mc-note">No pumps yet. The owner or manager adds tanks and pumps in "Tanks & pumps".</div>;
  return (
    <div className="form-stack">
      <div className="form-row-3">
        <Field label="Date"><input type="date" className="form-input" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Shift"><input className="form-input" list="shift-names" value={shiftName} onChange={(e) => setShiftName(e.target.value)} />
          <datalist id="shift-names"><option value="Day" /><option value="Night" /><option value="Morning" /><option value="Evening" /></datalist></Field>
        <Field label="Note"><input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      <div className="table-wrap lines-table">
        <table>
          <thead><tr><th>Pump</th><th>Fuel</th><th>Opening meter</th><th>Closing meter</th><th className="num">Litres sold</th><th className="num">Price</th><th className="num">Money expected</th></tr></thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.p.id}>
                <td><strong>{r.p.name}</strong><div className="small muted">{r.p.tank_name}</div></td>
                <td>{r.p.fuel_name}</td>
                <td><input className="form-input" inputMode="decimal" style={{ width: 130 }} value={opening[r.p.id] ?? ''} onChange={(e) => setOpening({ ...opening, [r.p.id]: e.target.value })} />
                  {r.gap && <div className="small" style={{ color: '#b91c1c' }}>Last closing was {num(r.p.last_meter)}</div>}</td>
                <td><input className="form-input" inputMode="decimal" style={{ width: 130 }} value={closing[r.p.id] ?? ''} onChange={(e) => setClosing({ ...closing, [r.p.id]: e.target.value })} placeholder="Read the meter" />
                  {r.bad && <div className="small" style={{ color: '#b91c1c' }}>Lower than opening</div>}</td>
                <td className="num">{r.c !== null ? num(r.liters) : '—'}</td>
                <td className="num">{money(r.p.sale_price)}</td>
                <td className="num">{r.c !== null ? money(r.amount) : '—'}</td>
              </tr>
            ))}
            <tr><td colSpan={4}><strong>Total</strong></td><td className="num"><strong>{num(liters)} L</strong></td><td></td><td className="num"><strong>{money(expected)}</strong></td></tr>
          </tbody>
        </table>
      </div>

      <div className="grid-2">
        <Field label="Money received (count it)"><PaymentsEditor value={payments} onChange={setPayments} /></Field>
        <Field label="Fuel given on credit">
          <div className="pay-lines">
            {credits.map((c, i) => (
              <div className="pay-line" key={i}>
                <PartySelect kind="customers" value={c.customer} items={customers.data ?? []} placeholder="Choose customer…" onCreated={customers.reload}
                  onChange={(v) => setCredits(credits.map((x, j) => (j === i ? { ...x, customer: v } : x)))} />
                <MoneyInput value={c.amount} onChange={(v) => setCredits(credits.map((x, j) => (j === i ? { ...x, amount: v } : x)))} />
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => setCredits(credits.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <div><button type="button" className="btn btn-ghost btn-xs" onClick={() => setCredits([...credits, { customer: '', amount: '' }])}>+ Add credit customer</button></div>
          </div>
        </Field>
      </div>

      <div className="stat-grid">
        <Stat label="Expected from meters" value={money(expected)} />
        <Stat label="Received + credit" value={money(collected + credit)} sub={`Cash/mobile ${money(collected)} · credit ${money(credit)}`} />
        <Stat label={diff < 0 ? 'Short' : diff > 0 ? 'Over' : 'Difference'} value={money(Math.abs(diff))} tone={diff !== 0 ? 'red' : 'green'} />
      </div>
      {diff !== 0 && entered.length > 0 && (
        <Field label="Explain the difference (required)"><input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. attendant short, wrong change, test fuel returned" /></Field>
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !entered.length || entered.some((r: any) => r.bad) || credits.some((c) => !c.customer) || (diff !== 0 && !reason.trim())} onClick={save}>
          Save shift
        </button>
      </div>
    </div>
  );
}

function ShiftList({ onChange }: { onChange: () => void }) {
  const { today, can } = useAuth();
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const list = useLoad(() => get('/fuel/shifts', { from, to }), [from, to]);
  const [open, setOpen] = useState<any>(null);
  const [voiding, setVoiding] = useState(false);
  return (
    <>
      <div style={{ marginBottom: 12 }}><DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} /></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Shift</th><th className="num">Litres</th><th className="num">Expected</th><th className="num">Received</th><th className="num">Credit</th><th className="num">Difference</th><th>Status</th><th>By</th></tr></thead>
          <tbody>
            {(list.data ?? []).map((s: any) => (
              <tr key={s.id} className="tr--clickable" onClick={async () => setOpen(await get(`/fuel/shifts/${s.id}`))}>
                <td>{s.entry_date}</td><td>{s.shift_name}</td><td className="num">{num(s.total_liters)}</td>
                <td className="num">{money(s.expected_amount)}</td><td className="num">{money(s.collected_amount)}</td><td className="num">{money(s.credit_amount)}</td>
                <td className="num"><Money c={s.difference} signed />{s.difference_reason && <div className="small muted">{s.difference_reason}</div>}</td>
                <td>{s.status === 'voided' ? <StatusBadge label="Cancelled" tone="red" /> : s.meter_gap_note ? <StatusBadge label="Meter gap" tone="red" /> : <StatusBadge label="Saved" tone="green" />}</td>
                <td className="small muted">{s.created_by_name}</td>
              </tr>
            ))}
            {!list.loading && !list.data?.length && <tr><td colSpan={9} className="muted">No shifts in this period.</td></tr>}
          </tbody>
        </table>
      </div>
      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title={open ? `Shift ${open.entry_date} · ${open.shift_name}` : ''} width="lg"
        footer={open && <>
          {can('void') && open.status === 'completed' && <button type="button" className="btn btn-danger" onClick={() => setVoiding(true)}>Cancel shift</button>}
          <button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print</button>
        </>}>
        {open && (
          <div className="print-area form-stack">
            <h3 className="print-only">Meecaad Fuel Station — shift {open.entry_date} {open.shift_name}</h3>
            {open.status === 'voided' && <div className="mc-error">Cancelled by {open.voided_by_name}: {open.void_reason}</div>}
            {open.meter_gap_note && <div className="mc-error">Meter gap: {open.meter_gap_note}</div>}
            <table>
              <thead><tr><th>Pump</th><th>Fuel</th><th className="num">Opening</th><th className="num">Closing</th><th className="num">Litres</th><th className="num">Price</th><th className="num">Amount</th></tr></thead>
              <tbody>{open.readings.map((r: any) => (
                <tr key={r.id}><td>{r.pump_name}</td><td>{r.fuel_name}</td><td className="num">{num(r.opening_meter)}</td><td className="num">{num(r.closing_meter)}</td>
                  <td className="num">{num(r.liters)}</td><td className="num">{money(r.unit_price)}</td><td className="num">{money(r.amount)}</td></tr>
              ))}</tbody>
            </table>
            <div className="kv">
              <span>Expected from meters</span><span>{money(open.expected_amount)}</span>
              {open.payments.map((p: any) => <Fragment key={p.id}><span>{p.method_name ? `Received ${p.method_name}` : `Credit: ${p.customer_name}`}</span><span>{money(p.amount)}</span></Fragment>)}
              <span className="kv-total">Difference</span><span className="kv-total"><Money c={open.difference} signed /></span>
            </div>
            {open.difference_reason && <p className="small">Reason: {open.difference_reason}</p>}
            <p className="small muted">Recorded by {open.created_by_name} at {fmtTime(open.created_at)}</p>
          </div>
        )}
      </Modal>
      {open && <ReasonModal open={voiding} onClose={() => setVoiding(false)} title="Cancel this shift?" action={`/fuel/shifts/${open.id}/void`} confirmLabel="Cancel shift"
        message="The litres go back to the tank, the pump meters go back to their opening readings, and the money is reversed. Only the latest shift of a pump can be cancelled."
        onDone={() => { setOpen(null); list.reload(); onChange(); }} />}
    </>
  );
}

function Dips({ tanks, onSaved }: { tanks: any[]; onSaved: () => void }) {
  const { today } = useAuth();
  const list = useLoad(() => get('/fuel/dips'), []);
  const [tank, setTank] = useState('');
  const [measured, setMeasured] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today);
  const { run, busy } = useSubmit();
  const t = tanks.find((x) => x.id === tank);
  const variance = t && measured !== '' ? Math.round((Number(measured) - t.stock_qty) * 1000) / 1000 : 0;
  const save = async () => {
    const r = await run((key) => post('/fuel/dips', { tank, measuredQty: Number(measured), reason, date }, key), 'Dip saved');
    if (r) { setMeasured(''); setReason(''); list.reload(); onSaved(); }
  };
  return (
    <div className="form-stack">
      <div className="form-row-3">
        <Field label="Tank"><select className="form-select" value={tank} onChange={(e) => setTank(e.target.value)}>
          <option value="">Choose…</option>{tanks.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.fuel_name}</option>)}</select></Field>
        <Field label="Litres measured (dip stick)"><input className="form-input" inputMode="decimal" value={measured} onChange={(e) => setMeasured(e.target.value)} /></Field>
        <Field label="Date"><input type="date" className="form-input" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {t && measured !== '' && (
        <div className={variance < 0 ? 'mc-error' : variance > 0 ? 'mc-warn' : 'mc-note'}>
          System expects {num(t.stock_qty)} L. Measured {num(Number(measured))} L. {variance === 0 ? 'No difference.' : `${variance < 0 ? 'Missing' : 'Extra'} ${num(Math.abs(variance))} L (about ${money(Math.round(Math.abs(variance) * t.avg_cost))} at cost).`}
        </div>
      )}
      {variance !== 0 && <Field label="Reason (required)"><input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. evaporation, leak, meter not calibrated" /></Field>}
      <div className="form-actions"><button type="button" className="btn btn-primary" disabled={busy || !tank || measured === '' || (variance !== 0 && !reason.trim())} onClick={save}>Save dip</button></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Tank</th><th className="num">System (book)</th><th className="num">Measured</th><th className="num">Difference</th><th className="num">Value</th><th>Reason</th><th>By</th></tr></thead>
          <tbody>
            {(list.data ?? []).map((d: any) => (
              <tr key={d.id}><td>{d.entry_date}</td><td>{d.tank_name}</td><td className="num">{num(d.book_qty)}</td><td className="num">{num(d.measured_qty)}</td>
                <td className="num" style={{ color: d.variance < 0 ? '#b91c1c' : undefined }}>{d.variance > 0 ? '+' : ''}{num(d.variance)} L</td>
                <td className="num"><Money c={d.variance_value} signed /></td><td className="small">{d.reason}</td><td className="small muted">{d.created_by_name}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Reconciliation() {
  const { today } = useAuth();
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const r = useLoad(() => get('/fuel/reconciliation', { from, to }), [from, to]);
  const d = r.data;
  return (
    <div className="form-stack print-area">
      <div className="row row--between no-print">
        <DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} />
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button>
      </div>
      <h3 className="print-only">Fuel reconciliation {from} – {to}</h3>
      <ErrorBox error={r.error} />
      {d && (
        <>
          <div className="mc-note">Start + delivered − sold by meters ± dip corrections = what should be in the tank. Compare it with the last dip: a gap means fuel is missing or a meter is wrong.</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Tank</th><th className="num">At start</th><th className="num">+ Delivered</th><th className="num">− Sold (meters)</th><th className="num">± Dip corrections</th><th className="num">Should be now</th><th>Last dip</th></tr></thead>
              <tbody>
                {d.tanks.map((t: any) => (
                  <tr key={t.id}>
                    <td><strong>{t.name}</strong><div className="small muted">{t.fuel_name}</div></td>
                    <td className="num">{num(t.opening + t.opened)}</td>
                    <td className="num">{num(t.delivered)}</td>
                    <td className="num">{num(t.sold)}</td>
                    <td className="num" style={{ color: t.dip_variance < 0 ? '#b91c1c' : undefined }}>{t.dip_variance > 0 ? '+' : ''}{num(t.dip_variance)}</td>
                    <td className="num"><strong>{num(t.closing)} L</strong></td>
                    <td className="small">{t.last_dip_date ? `${num(t.last_dip_qty)} L on ${t.last_dip_date}` : <span style={{ color: '#b45309' }}>No dip recorded</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid-2">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Day</th><th className="num">Litres</th><th className="num">Expected</th><th className="num">Received</th><th className="num">Credit</th><th className="num">Difference</th></tr></thead>
                <tbody>{d.days.map((x: any) => (
                  <tr key={x.entry_date}><td>{x.entry_date}</td><td className="num">{num(x.liters)}</td><td className="num">{money(x.expected)}</td><td className="num">{money(x.collected)}</td>
                    <td className="num">{money(x.credit)}</td><td className="num"><Money c={x.difference} signed /></td></tr>
                ))}{!d.days.length && <tr><td colSpan={6} className="muted">No shifts.</td></tr>}</tbody>
              </table>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Fuel</th><th className="num">Litres sold</th><th className="num">Sales</th></tr></thead>
                <tbody>{d.byFuel.map((x: any) => <tr key={x.fuel_name}><td>{x.fuel_name}</td><td className="num">{num(x.liters)}</td><td className="num">{money(x.amount)}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Setup({ data, onChange }: { data: any; onChange: () => void }) {
  const products = useLoad(() => get('/products', { business: 'fuel' }), []);
  const fuels = (products.data ?? []).filter((p: any) => p.kind === 'fuel' && p.active);
  const [tank, setTank] = useState({ product: '', name: '', capacity: '', openingQty: '', openingCost: '' });
  const [pump, setPump] = useState({ tank: '', name: '', meter: '' });
  const [editPump, setEditPump] = useState<any>(null);
  const { run, busy } = useSubmit();
  const addTank = async () => {
    const r = await run((key) => post('/fuel/tanks', { ...tank, capacity: Number(tank.capacity) || 0, openingQty: Number(tank.openingQty) || 0, openingCost: toCents(tank.openingCost) }, key), 'Tank added');
    if (r) { setTank({ product: '', name: '', capacity: '', openingQty: '', openingCost: '' }); onChange(); }
  };
  const addPump = async () => {
    const r = await run((key) => post('/fuel/pumps', { ...pump, meter: Number(pump.meter) || 0 }, key), 'Pump added');
    if (r) { setPump({ tank: '', name: '', meter: '' }); onChange(); }
  };
  return (
    <div className="form-stack">
      {!fuels.length && <div className="mc-warn">First add the fuel types (e.g. Petrol, Diesel) with their price per litre in Stock & Products.</div>}
      <div className="grid-2">
        <div className="form-stack">
          <h3 style={{ margin: 0 }}>Add a tank</h3>
          <div className="form-row">
            <Field label="Fuel"><select className="form-select" value={tank.product} onChange={(e) => setTank({ ...tank, product: e.target.value })}>
              <option value="">Choose…</option>{fuels.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>
            <Field label="Tank name"><input className="form-input" value={tank.name} onChange={(e) => setTank({ ...tank, name: e.target.value })} placeholder="Tank 1" /></Field>
          </div>
          <div className="form-row-3">
            <Field label="Capacity (L)"><input className="form-input" inputMode="decimal" value={tank.capacity} onChange={(e) => setTank({ ...tank, capacity: e.target.value })} /></Field>
            <Field label="Litres in it now"><input className="form-input" inputMode="decimal" value={tank.openingQty} onChange={(e) => setTank({ ...tank, openingQty: e.target.value })} /></Field>
            <Field label="Cost per litre"><MoneyInput value={tank.openingCost} onChange={(v) => setTank({ ...tank, openingCost: v })} /></Field>
          </div>
          <div><button type="button" className="btn btn-primary btn-sm" disabled={busy || !tank.product || !tank.name.trim()} onClick={addTank}><Plus size={14} /> Add tank</button></div>
        </div>
        <div className="form-stack">
          <h3 style={{ margin: 0 }}>Add a pump / nozzle</h3>
          <div className="form-row">
            <Field label="Draws from tank"><select className="form-select" value={pump.tank} onChange={(e) => setPump({ ...pump, tank: e.target.value })}>
              <option value="">Choose…</option>{(data?.tanks ?? []).filter((t: any) => t.active).map((t: any) => <option key={t.id} value={t.id}>{t.name} · {t.fuel_name}</option>)}</select></Field>
            <Field label="Pump name"><input className="form-input" value={pump.name} onChange={(e) => setPump({ ...pump, name: e.target.value })} placeholder="Pump 1 – Diesel" /></Field>
          </div>
          <Field label="Current meter reading"><input className="form-input" inputMode="decimal" value={pump.meter} onChange={(e) => setPump({ ...pump, meter: e.target.value })} /></Field>
          <div><button type="button" className="btn btn-primary btn-sm" disabled={busy || !pump.tank || !pump.name.trim()} onClick={addPump}><Plus size={14} /> Add pump</button></div>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Pump</th><th>Tank</th><th>Fuel</th><th className="num">Price</th><th className="num">Last meter</th><th>Status</th><th></th></tr></thead>
          <tbody>{(data?.pumps ?? []).map((p: any) => (
            <tr key={p.id}><td>{p.name}</td><td>{p.tank_name}</td><td>{p.fuel_name}</td><td className="num">{money(p.sale_price)}</td><td className="num">{num(p.last_meter)}</td>
              <td>{p.active ? <StatusBadge label="Active" tone="green" /> : <StatusBadge label="Off" />}</td>
              <td><button type="button" className="btn btn-ghost btn-xs" onClick={() => setEditPump({ ...p, meter: String(p.last_meter), reason: '' })}>Edit</button></td></tr>
          ))}</tbody>
        </table>
      </div>
      {editPump && (
        <Modal open onClose={() => setEditPump(null)} title={`Edit ${editPump.name}`} width="sm"
          footer={<><button type="button" className="btn btn-secondary" onClick={() => setEditPump(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => {
              const r = await run(() => patch(`/fuel/pumps/${editPump.id}`, { name: editPump.name, active: Boolean(editPump.active), meter: Number(editPump.meter), reason: editPump.reason }), 'Saved');
              if (r) { setEditPump(null); onChange(); }
            }}>Save</button></>}>
          <div className="form-stack">
            <Field label="Name"><input className="form-input" value={editPump.name} onChange={(e) => setEditPump({ ...editPump, name: e.target.value })} /></Field>
            <Field label="Meter reading" hint="Only change this if the meter was replaced or reset. The change is recorded in the audit log.">
              <input className="form-input" inputMode="decimal" value={editPump.meter} onChange={(e) => setEditPump({ ...editPump, meter: e.target.value })} /></Field>
            {Number(editPump.meter) !== editPump.last_meter && <Field label="Reason for meter change (required)"><input className="form-input" value={editPump.reason} onChange={(e) => setEditPump({ ...editPump, reason: e.target.value })} /></Field>}
            <label className="row"><input type="checkbox" checked={Boolean(editPump.active)} onChange={(e) => setEditPump({ ...editPump, active: e.target.checked ? 1 : 0 })} /> Active</label>
          </div>
        </Modal>
      )}
      <p className="small muted">Fuel prices are changed in Stock & Products (every change is kept in the price history). Current price: {fuels.map((f: any) => `${f.name} ${money(f.sale_price)}/L`).join(', ') || '—'}</p>
    </div>
  );
}
