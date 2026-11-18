// Fuel station inventory, like a normal shop's: diesel, petrol, oils, tools … as many
// items as wanted. Each item has a COST PRICE (what one unit costs, US dollars — kept
// as an average as stock comes in) and a SELLING PRICE (US dollars or Shillings) that
// the sales team sells at. Receiving stock records what it cost and how it was paid.
import { useState } from 'react';
import { History, Package, Plus } from 'lucide-react';
import { get, money, patch, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { ErrorBox, Field, MoneyInput, PageHeader, PartySelect, Stat, fmtTime, useFilters, useLoad, useSubmit } from '../components/ui';

const UNITS = ['L', 'pcs', 'drum', 'kg', 'bottle', 'can', 'set'];
const CATEGORIES = ['Fuel', 'Oil', 'Tools', 'Spare parts', 'Other'];
const n3 = (n: number) => Number(n.toFixed(3)).toLocaleString('en-US');
/** A cost per unit in US cents (may have fractions of a cent): $0.955 */
const unitMoney = (c: number) => (Math.abs(c - Math.round(c)) > 0.0005 ? `$${(c / 100).toFixed(3)}` : money(Math.round(c)));
const sellText = (i: any) => (i.currency === 'USD' ? money(i.price) : `${i.price.toLocaleString('en-US')} SLSH`);
/** Selling price in US cents (Shilling prices at the rate), or null when it cannot be worked out. */
const sellUsd = (i: any, rate: number | null) => (i.currency === 'USD' ? i.price : rate ? (i.price / rate) * 100 : null);
const stockState = (i: any) => (!i.track_stock ? 'Not tracked' : i.stock_qty < 0 ? 'Below zero' : i.stock_qty === 0 ? 'Out' : i.reorder_level > 0 && i.stock_qty <= i.reorder_level ? 'Low' : 'OK');

/** Margin per unit and as % of the selling price. */
function Margin({ i, rate }: { i: any; rate: number | null }) {
  const s = sellUsd(i, rate);
  if (s === null || !i.cost_price) return <span className="muted">—</span>;
  const m = s - i.cost_price;
  return <span style={{ color: m < 0 ? '#b91c1c' : '#15803d' }}>{unitMoney(m)}<div className="small muted">{Math.round((m / s) * 100)}%</div></span>;
}

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
  const value = rows.reduce((t, i) => t + (i.track_stock ? i.stock_value : 0), 0);
  const reload = () => { items.reload(); rates.reload(); };

  return (
    <div className="module-page">
      <PageHeader icon={<Package size={22} />} title="Inventory" subtitle="Items with their cost price, selling price and stock. The sales team sells at the selling price."
        actions={<button type="button" className="btn btn-primary" onClick={() => setEdit({})}><Plus size={16} /> Add item</button>} />
      {needRate && <div className="mc-warn">Some items are sold in Shillings, but no exchange rate is set. Sales of those items are blocked until the manager sets it (Settings).</div>}
      <section className="stat-grid">
        <Stat label="Items" value={String(rows.filter((i) => i.active).length)} sub={rows.some((i) => !i.active) ? `${rows.filter((i) => !i.active).length} hidden` : 'all shown to sales'} />
        <Stat label="Stock value (at cost)" value={money(value)} />
        <Stat label="Need attention" value={String(attention)} tone={attention ? 'red' : 'green'} sub={attention ? 'low, out or below zero' : 'stock is fine'} />
        <Stat label="Exchange rate" value={rate ? `${rate.toLocaleString('en-US')} SLSH` : 'Not set'} sub={rate ? 'for $1' : 'the manager sets it in Settings'} />
      </section>
      <div className="panel">
        <ErrorBox error={items.error} />
        {filter.bar}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th className="num">Cost price</th><th className="num">Selling price</th><th className="num">Margin</th><th className="num">In stock</th><th className="num">Stock value</th><th className="num">Sold 30 days</th><th></th></tr></thead>
            <tbody>
              {filter.shown.map((i) => {
                const st = stockState(i);
                return (
                  <tr key={i.id} style={{ opacity: i.active ? 1 : 0.55 }}>
                    <td><strong>{i.name}</strong>{!i.active && <span className="small muted"> (hidden)</span>}<div className="small muted">{i.category || '—'} · per {i.unit}</div></td>
                    <td className="num">{i.cost_price ? unitMoney(i.cost_price) : <span className="muted">not set</span>}</td>
                    <td className="num"><strong>{sellText(i)}</strong>{rate && <div className="small muted">≈ {i.currency === 'USD' ? `${Math.round((i.price / 100) * rate).toLocaleString('en-US')} SLSH` : money(Math.round((i.price / rate) * 100))}</div>}</td>
                    <td className="num"><Margin i={i} rate={rate} /></td>
                    <td className="num">{i.track_stock ? <>{n3(i.stock_qty)} {i.unit}{' '}{st === 'Below zero' ? <StatusBadge label="Below zero" tone="red" /> : st === 'Out' ? <StatusBadge label="Out" tone="red" /> : st === 'Low' ? <StatusBadge label="Low" tone="yellow" /> : null}</> : <span className="muted">not tracked</span>}</td>
                    <td className="num">{i.track_stock ? money(i.stock_value) : '—'}</td>
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
              {!items.loading && !filter.shown.length && <tr><td colSpan={8} className="muted">{filter.active ? 'No item matches.' : 'No items yet. Add diesel, petrol, oils and the other things you sell, with their cost and selling prices.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>Receiving stock records what it cost and how it was paid (now, or owed to a supplier) — do not also record it as an expense. Each sale counts its cost, so profit is sales − cost of goods − expenses. Changing a price never changes sales already made.</p>
      </div>
      {edit && <ItemModal item={edit} rate={rate} existing={rows} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
      {stock && <StockModal item={stock.item} type={stock.type} onClose={() => setStock(null)} onDone={() => { setStock(null); reload(); }} />}
      {log && (
        <Modal open onClose={() => setLog(null)} title={`${log.item.name} — stock history`} width="lg">
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>What</th><th className="num">Change</th><th className="num">Value</th><th>Note</th><th>By</th></tr></thead>
              <tbody>
                {log.rows.map((r: any) => (
                  <tr key={r.id}><td className="small">{fmtTime(r.created_at)}</td>
                    <td>{{ received: 'Received', sale: 'Sold', sale_void: 'Sale cancelled', count: 'Count correction' }[r.type as string]}
                      {r.type === 'received' && (r.supplier_name || r.method_name) && <div className="small muted">{r.method_name ? `paid ${r.method_name}` : 'owed'}{r.supplier_name ? ` · ${r.supplier_name}` : ''}</div>}</td>
                    <td className="num" style={{ color: r.qty < 0 ? '#b91c1c' : '#15803d' }}>{r.qty > 0 ? '+' : ''}{n3(r.qty)} {log.item.unit}</td>
                    <td className="num">{r.value !== null && r.value !== undefined ? money(r.value) : '—'}</td>
                    <td className="small">{r.reason}</td><td className="small">{r.created_by_name}</td></tr>
                ))}
                {!log.rows.length && <tr><td colSpan={6} className="muted">Nothing yet.</td></tr>}
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
    cost: item.cost_price ? String(Math.round(item.cost_price * 10) / 1000) : '',
    price: item.price ? (item.currency === 'SLSH' ? String(item.price) : (item.price / 100).toFixed(2)) : '',
    track: Boolean(item.track_stock ?? 1), openingQty: '', reorder: item.reorder_level ? String(item.reorder_level) : '', active: Boolean(item.active ?? 1),
  });
  const { run, busy } = useSubmit();
  const costC = Math.round(Number(f.cost || 0) * 100 * 1000) / 1000;   // cents, fractions allowed
  const priceVal = f.currency === 'USD' ? toCents(f.price) : Math.round(Number(f.price) || 0);
  const sellC = f.currency === 'USD' ? priceVal : rate ? (priceVal / rate) * 100 : null;
  const margin = sellC !== null && priceVal > 0 && costC > 0 ? sellC - costC : null;
  const categories = [...new Set([...CATEGORIES, ...existing.map((i) => i.category).filter(Boolean)])];
  const save = async () => {
    const body = { name: f.name, category: f.category, unit: f.unit, currency: f.currency, price: priceVal, costPrice: costC, trackStock: f.track, reorderLevel: f.reorder || 0, active: f.active, ...(isNew ? { openingQty: f.openingQty || 0 } : {}) };
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
          <Field label="Unit"><input className="form-input" list="fuel-units" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
            <datalist id="fuel-units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist></Field>
          <Field label="Cost price (USD)" hint={`What one ${f.unit || 'unit'} costs you. Becomes an average when stock comes in at a different cost.`}>
            <input className="form-input" inputMode="decimal" value={f.cost} placeholder="0.00" onChange={(e) => setF({ ...f, cost: e.target.value.replace(/[^0-9.]/g, '') })} />
          </Field>
        </div>
        <Field label="Selling price" hint={margin !== null ? `Margin ${unitMoney(margin)} per ${f.unit || 'unit'} (${Math.round((margin / (sellC as number)) * 100)}%)${f.currency === 'SLSH' && rate ? ` · ≈ ${money(Math.round(sellC as number))}` : ''}` : f.currency === 'SLSH' && !rate ? 'The manager must set the exchange rate so Shilling prices can be added up in dollars' : undefined}>
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {f.currency === 'USD' ? <MoneyInput value={f.price} onChange={(v) => setF({ ...f, price: v })} /> : <input className="form-input" inputMode="numeric" value={f.price} placeholder="15000" onChange={(e) => setF({ ...f, price: e.target.value.replace(/[^0-9]/g, '') })} />}
            </div>
            <button type="button" className={`btn btn-sm ${f.currency === 'USD' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setF({ ...f, currency: 'USD', price: '' })}>USD</button>
            <button type="button" className={`btn btn-sm ${f.currency === 'SLSH' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setF({ ...f, currency: 'SLSH', price: '' })}>SLSH</button>
          </div>
        </Field>
        {margin !== null && margin < 0 && <div className="mc-error">The selling price is lower than the cost price: every sale loses money.</div>}
        {!isNew && costC !== item.cost_price && item.stock_qty !== 0 && <div className="mc-warn">Changing the cost price changes what the {n3(item.stock_qty)} {item.unit} in stock are worth. The difference is recorded.</div>}
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
  const { activeMethods } = useAuth();
  const suppliers = useLoad(() => (type === 'received' ? get('/suppliers', { business: 'fuel' }) : Promise.resolve([])), [type]);
  const [v, setV] = useState('');
  const [cost, setCost] = useState(item.cost_price ? String(Math.round(item.cost_price * 10) / 1000) : '');
  const [paid, setPaid] = useState('cash');   // a payment method, or 'owed'
  const [supplier, setSupplier] = useState('');
  const [reason, setReason] = useState('');
  const { run, busy } = useSubmit();
  const n = Number(v);
  const costC = Math.round(Number(cost || 0) * 100 * 1000) / 1000;
  const total = Math.round(n * costC);
  const diff = type === 'count' && v !== '' ? Math.round((n - item.stock_qty) * 1000) / 1000 : 0;
  const ok = v !== '' && n >= 0 && (type === 'received' ? n > 0 && (paid !== 'owed' || supplier) : diff !== 0 && reason.trim() !== '');
  const save = async () => {
    const body = type === 'received'
      ? { type, qty: n, unitCost: costC, reason, ...(paid === 'owed' ? { supplier } : { method: paid, supplier: supplier || undefined }) }
      : { type, counted: n, reason };
    if (await run((key) => post(`/fuel/items/${item.id}/stock`, body, key), type === 'received' ? 'Stock received' : 'Stock corrected')) onDone();
  };
  return (
    <Modal open onClose={onClose} title={`${type === 'received' ? 'Receive stock' : 'Count the stock'} — ${item.name}`} width="md"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !ok} onClick={save}>Save</button></>}>
      <div className="form-stack">
        <p className="small muted" style={{ margin: 0 }}>The system has {n3(item.stock_qty)} {item.unit}{item.cost_price ? ` at ${unitMoney(item.cost_price)} each` : ''}.</p>
        {type === 'received' ? (
          <>
            <div className="form-row">
              <Field label={`Quantity received (${item.unit})`}><input className="form-input" inputMode="decimal" value={v} autoFocus onChange={(e) => setV(e.target.value.replace(/[^0-9.]/g, ''))} /></Field>
              <Field label={`Cost per ${item.unit} (USD)`}><input className="form-input" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^0-9.]/g, ''))} /></Field>
            </div>
            {n > 0 && <div className="cart-total"><span>Total cost</span><span>{money(total)}</span></div>}
            <Field label="Paid with">
              <select className="form-select" value={paid} onChange={(e) => setPaid(e.target.value)}>
                {activeMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                <option value="owed">Not paid yet (owed to the supplier)</option>
              </select>
            </Field>
            <Field label={paid === 'owed' ? 'Supplier (required)' : 'Supplier (optional)'}>
              <PartySelect kind="suppliers" value={supplier} onChange={setSupplier} items={suppliers.data ?? []} onCreated={suppliers.reload} placeholder="Choose the supplier…" />
            </Field>
            <Field label="Note (optional)"><input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. delivery note number" /></Field>
            {n > 0 && <p className="small" style={{ margin: 0 }}>New stock: <strong>{n3(item.stock_qty + n)} {item.unit}</strong>. Do not also record this as an expense.</p>}
          </>
        ) : (
          <>
            <Field label={`Quantity you counted (${item.unit})`}><input className="form-input" inputMode="decimal" value={v} autoFocus onChange={(e) => setV(e.target.value.replace(/[^0-9.]/g, ''))} /></Field>
            {v !== '' && <div className={diff === 0 ? 'mc-note' : diff < 0 ? 'mc-error' : 'mc-warn'}>{diff === 0 ? 'Matches the system.' : `${diff < 0 ? 'Missing' : 'Extra'} ${n3(Math.abs(diff))} ${item.unit}${item.cost_price ? ` (worth ${money(Math.round(Math.abs(diff) * item.cost_price))})` : ''}.`}</div>}
            <Field label="Reason (required)"><input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. evaporation, leak, counted wrong" /></Field>
          </>
        )}
      </div>
    </Modal>
  );
}
