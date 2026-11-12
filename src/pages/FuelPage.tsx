import { useState } from 'react';
import { Printer, Plus } from 'lucide-react';
import { get, money, num, patch, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { DateRange, ErrorBox, Field, Money, MoneyInput, addDays, useLoad, useSubmit } from '../components/ui';

export function Dips({ tanks, onSaved }: { tanks: any[]; onSaved: () => void }) {
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

export function Reconciliation() {
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
      <img className="print-only print-logo" src="/logo-full.svg" alt="Meecaad" />
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

export function Setup({ data, onChange }: { data: any; onChange: () => void }) {
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
      {!fuels.length && <div className="mc-warn">First add the fuel types (e.g. Petrol, Diesel) with their price per litre in Settings → Fuel prices.</div>}
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
      <p className="small muted">Fuel prices are changed in Settings → Fuel prices (every change is kept in the price history). Current price: {fuels.map((f: any) => `${f.name} ${money(f.sale_price)}/L`).join(', ') || '—'}</p>
    </div>
  );
}
