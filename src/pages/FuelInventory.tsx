// Fuel station inventory (manager / owner): diesel, petrol, oils, tools … as many
// items as wanted. The price of each item is set here, in US dollars or Somaliland
// Shillings, and the sales team sells at that price. Stock goes down with each sale.
import { useState } from 'react';
import { History, Package, Plus } from 'lucide-react';
import { get, money, patch, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { ErrorBox, Field, MoneyInput, PageHeader, Stat, fmtTime, useFilters, useLoad, useSubmit } from '../components/ui';
import { priceText } from './FuelStation';

const UNITS = ['L', 'pcs', 'drum', 'kg', 'bottle', 'can', 'set'];
const CATEGORIES = ['Fuel', 'Oil', 'Tools', 'Spare parts', 'Other'];
const n3 = (n: number) => Number(n.toFixed(3)).toLocaleString('en-US');
const stockState = (i: any) => (!i.track_stock ? 'Not tracked' : i.stock_qty < 0 ? 'Below zero' : i.stock_qty === 0 ? 'Out' : i.reorder_level > 0 && i.stock_qty <= i.reorder_level ? 'Low' : 'OK');

export function FuelInventory() {
  const items = useLoad(() => get('/fuel/items'), []);
  const rates = useLoad(() => get('/rates'), []);
  const rate: number | null = rates.data?.current?.rate ?? null;
  const [edit, setEdit] = useState<any>(null);
  const [stock, setStock] = useState<{ item: any; type: 'received' | 'count' } | null>(null);
  const [log, setLog] = useState<any>(null);
  const rows: any[] = items.data ?? [];
  const filter = useFilters<any>(rows, [
    { key: 'cat', label: 'Category', get: (i) => i.category || 'No category' },
    { key: 'stock', label: 'Stock', get: (i) => stockState(i) },
    { key: 'active', label: 'Shown to sales', get: (i) => (i.active ? 'Yes' : 'Hidden') },
  ], (i) => `${i.name} ${i.category}`, 'Search item or category');
  const attention = rows.filter((i) => i.active && ['Below zero', 'Out', 'Low'].includes(stockState(i))).length;
  const needRate = rows.some((i) => i.active && i.currency === 'SLSH') && !rate;
  const reload = () => { items.reload(); rates.reload(); };

  return (
    <div className="module-page">
      <PageHeader icon={<Package size={22} />} title="Inventory" subtitle="Items, their prices and the stock. The sales team sells at the prices you set here."
        actions={<button type="button" className="btn btn-primary" onClick={() => setEdit({})}><Plus size={16} /> Add item</button>} />
      {needRate && <div className="mc-warn">Some items are priced in Shillings, but no exchange rate is set. Sales of those items are blocked until you set it (Settings).</div>}
      <section className="stat-grid">
        <Stat label="Items" value={String(rows.filter((i) => i.active).length)} sub={rows.some((i) => !i.active) ? `${rows.filter((i) => !i.active).length} hidden` : 'all shown to sales'} />
        <Stat label="Need attention" value={String(attention)} tone={attention ? 'red' : 'green'} sub={attention ? 'low, out or below zero' : 'stock is fine'} />
        <Stat label="Exchange rate" value={rate ? `${rate.toLocaleString('en-US')} SLSH` : 'Not set'} sub={rate ? 'for $1' : 'set it in Settings'} />
      </section>
      <div className="panel">
        <ErrorBox error={items.error} />
        {filter.bar}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th className="num">Price</th><th className="num">In stock</th><th className="num">Sold 30 days</th><th></th></tr></thead>
            <tbody>
              {filter.shown.map((i) => {
                const st = stockState(i);
                return (
                  <tr key={i.id} style={{ opacity: i.active ? 1 : 0.55 }}>
                    <td><strong>{i.name}</strong>{!i.active && <span className="small muted"> (hidden)</span>}<div className="small muted">{i.category || '—'} · per {i.unit}</div></td>
                    <td className="num"><strong>{i.currency === 'USD' ? money(i.price) : `${i.price.toLocaleString('en-US')} SLSH`}</strong>
                      {rate && <div className="small muted">≈ {i.currency === 'USD' ? `${Math.round((i.price / 100) * rate).toLocaleString('en-US')} SLSH` : money(Math.round((i.price / rate) * 100))}</div>}</td>
                    <td className="num">{i.track_stock ? <>{n3(i.stock_qty)} {i.unit}{' '}{st === 'Below zero' ? <StatusBadge label="Below zero" tone="red" /> : st === 'Out' ? <StatusBadge label="Out" tone="red" /> : st === 'Low' ? <StatusBadge label="Low" tone="yellow" /> : null}</> : <span className="muted">not tracked</span>}</td>
                    <td className="num">{n3(i.sold_30d)} {i.unit}</td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 2, flexWrap: 'wrap' }}>
                        {i.track_stock ? <><button type="button" className="btn btn-ghost btn-xs" onClick={() => setStock({ item: i, type: 'received' })}>Receive stock</button>
                          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setStock({ item: i, type: 'count' })}>Count</button>
                          <button type="button" className="btn btn-ghost btn-xs" onClick={async () => setLog({ item: i, rows: await get(`/fuel/items/${i.id}/log`) })} aria-label="Stock history"><History size={13} /></button></> : null}
                        <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEdit(i)}>Edit</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!items.loading && !filter.shown.length && <tr><td colSpan={5} className="muted">{filter.active ? 'No item matches.' : 'No items yet. Add diesel, petrol, oils and the other things you sell, with their prices.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>Receiving stock only adds the quantity. Record what you paid for a delivery under Expenses. Changing a price never changes sales already made.</p>
      </div>
      {edit && <ItemModal item={edit} rate={rate} existing={rows} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
      {stock && <StockModal item={stock.item} type={stock.type} onClose={() => setStock(null)} onDone={() => { setStock(null); reload(); }} />}
      {log && (
        <Modal open onClose={() => setLog(null)} title={`${log.item.name} — stock history`} width="lg">
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>What</th><th className="num">Change</th><th>Note</th><th>By</th></tr></thead>
              <tbody>
                {log.rows.map((r: any) => (
                  <tr key={r.id}><td className="small">{fmtTime(r.created_at)}</td>
                    <td>{{ received: 'Received', sale: 'Sold', sale_void: 'Sale cancelled', count: 'Count correction' }[r.type as string]}</td>
                    <td className="num" style={{ color: r.qty < 0 ? '#b91c1c' : '#15803d' }}>{r.qty > 0 ? '+' : ''}{n3(r.qty)} {log.item.unit}</td>
                    <td className="small">{r.reason}</td><td className="small">{r.created_by_name}</td></tr>
                ))}
                {!log.rows.length && <tr><td colSpan={5} className="muted">Nothing yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ItemModal({ item, rate, existing, onClose, onDone }: { item: any; rate: number | null; existing: any[]; onClose: () => void; onDone: () => void }) {
  const isNew = !item.id;
  const [f, setF] = useState({
    name: item.name ?? '', category: item.category ?? '', unit: item.unit ?? 'L', currency: (item.currency ?? 'USD') as 'USD' | 'SLSH',
    price: item.price ? (item.currency === 'SLSH' ? String(item.price) : (item.price / 100).toFixed(2)) : '',
    track: Boolean(item.track_stock ?? 1), openingQty: '', reorder: item.reorder_level ? String(item.reorder_level) : '', active: Boolean(item.active ?? 1),
  });
  const { run, busy } = useSubmit();
  const priceVal = f.currency === 'USD' ? toCents(f.price) : Math.round(Number(f.price) || 0);
  const equivalent = !priceVal || !rate ? null : f.currency === 'USD' ? `≈ ${Math.round((priceVal / 100) * rate).toLocaleString('en-US')} SLSH` : `≈ ${money(Math.round((priceVal / rate) * 100))}`;
  const categories = [...new Set([...CATEGORIES, ...existing.map((i) => i.category).filter(Boolean)])];
  const save = async () => {
    const body = { name: f.name, category: f.category, unit: f.unit, currency: f.currency, price: priceVal, trackStock: f.track, reorderLevel: f.reorder || 0, active: f.active, ...(isNew ? { openingQty: f.openingQty || 0 } : {}) };
    if (await run((key) => (isNew ? post('/fuel/items', body, key) : patch(`/fuel/items/${item.id}`, body)), isNew ? 'Item added' : 'Saved')) onDone();
  };
  return (
    <Modal open onClose={onClose} title={isNew ? 'Add item' : `Edit ${item.name}`} width="lg"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !f.name.trim() || !(priceVal > 0)} onClick={save}>Save</button></>}>
      <div className="form-stack">
        <div className="form-row">
          <Field label="Name"><input className="form-input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Diesel, Engine oil 20W-50" autoFocus /></Field>
          <Field label="Category"><input className="form-input" list="fuel-cats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Fuel, Oil, Tools …" />
            <datalist id="fuel-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist></Field>
        </div>
        <div className="form-row">
          <Field label="Sold per (unit)"><input className="form-input" list="fuel-units" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
            <datalist id="fuel-units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist></Field>
          <Field label={`Price per ${f.unit || 'unit'}`} hint={equivalent ?? (f.currency === 'SLSH' && !rate ? 'Set the exchange rate in Settings so sales can be added up in dollars' : undefined)}>
            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {f.currency === 'USD' ? <MoneyInput value={f.price} onChange={(v) => setF({ ...f, price: v })} /> : <input className="form-input" inputMode="numeric" value={f.price} placeholder="15000" onChange={(e) => setF({ ...f, price: e.target.value.replace(/[^0-9]/g, '') })} />}
              </div>
              <button type="button" className={`btn btn-sm ${f.currency === 'USD' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setF({ ...f, currency: 'USD', price: '' })}>USD</button>
              <button type="button" className={`btn btn-sm ${f.currency === 'SLSH' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setF({ ...f, currency: 'SLSH', price: '' })}>SLSH</button>
            </div>
          </Field>
        </div>
        <label className="row"><input type="checkbox" checked={f.track} onChange={(e) => setF({ ...f, track: e.target.checked })} /> Keep track of the stock of this item</label>
        {f.track && (
          <div className="form-row">
            {isNew && <Field label={`In stock now (${f.unit || 'units'})`}><input className="form-input" inputMode="decimal" value={f.openingQty} onChange={(e) => setF({ ...f, openingQty: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="0" /></Field>}
            <Field label="Warn me when stock is at or below" hint="Leave empty for no warning"><input className="form-input" inputMode="decimal" value={f.reorder} onChange={(e) => setF({ ...f, reorder: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
          </div>
        )}
        {!isNew && <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Shown to the sales team (untick to hide it; its history stays)</label>}
      </div>
    </Modal>
  );
}

function StockModal({ item, type, onClose, onDone }: { item: any; type: 'received' | 'count'; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState('');
  const [reason, setReason] = useState('');
  const { run, busy } = useSubmit();
  const n = Number(v);
  const diff = type === 'count' && v !== '' ? Math.round((n - item.stock_qty) * 1000) / 1000 : 0;
  const ok = v !== '' && n >= 0 && (type === 'received' ? n > 0 : diff !== 0 && reason.trim() !== '');
  const save = async () => {
    const body = type === 'received' ? { type, qty: n, reason } : { type, counted: n, reason };
    if (await run((key) => post(`/fuel/items/${item.id}/stock`, body, key), type === 'received' ? 'Stock added' : 'Stock corrected')) onDone();
  };
  return (
    <Modal open onClose={onClose} title={`${type === 'received' ? 'Receive stock' : 'Count the stock'} — ${item.name}`} width="sm"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !ok} onClick={save}>Save</button></>}>
      <div className="form-stack">
        <p className="small muted" style={{ margin: 0 }}>The system has {n3(item.stock_qty)} {item.unit}.</p>
        <Field label={type === 'received' ? `Quantity received (${item.unit})` : `Quantity you counted (${item.unit})`}>
          <input className="form-input" inputMode="decimal" value={v} autoFocus onChange={(e) => setV(e.target.value.replace(/[^0-9.]/g, ''))} />
        </Field>
        {type === 'received' && v !== '' && n > 0 && <p className="small" style={{ margin: 0 }}>New stock: <strong>{n3(item.stock_qty + n)} {item.unit}</strong></p>}
        {type === 'count' && v !== '' && <div className={diff === 0 ? 'mc-note' : diff < 0 ? 'mc-error' : 'mc-warn'}>{diff === 0 ? 'Matches the system.' : `${diff < 0 ? 'Missing' : 'Extra'} ${n3(Math.abs(diff))} ${item.unit}.`}</div>}
        <Field label={type === 'received' ? 'Note (optional)' : 'Reason (required)'}>
          <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={type === 'received' ? 'e.g. delivery from the depot' : 'e.g. evaporation, leak, counted wrong'} />
        </Field>
      </div>
    </Modal>
  );
}
