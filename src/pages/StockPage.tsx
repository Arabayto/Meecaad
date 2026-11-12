import { useState } from 'react';
import { PackageSearch, Plus } from 'lucide-react';
import { fromCents, get, money, num, patch, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { Tabs } from '../components/Tabs';
import { ErrorBox, Field, Money, MoneyInput, PageHeader, fmtTime, useFilters, useLoad, useSubmit } from '../components/ui';
import { ItemPicture } from './RestaurantPage';

/** Crop a photo to a square and shrink it to 320 px in the browser (WebP, or JPEG where WebP is not supported). */
function shrinkPicture(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height), size = Math.min(320, side);
      const c = document.createElement('canvas'); c.width = size; c.height = size;
      c.getContext('2d')!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      const webp = c.toDataURL('image/webp', 0.8);
      resolve(webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('Could not read this picture'));
    img.src = URL.createObjectURL(file);
  });
}

const KIND_LABEL: Record<string, string> = { menu: 'Menu item', ingredient: 'Ingredient / kitchen stock', item: 'Product', fuel: 'Fuel type' };
/** Each catalog page shows one kind of item of one business. */
export type CatalogView = 'menu' | 'products' | 'fuels';
const VIEW: Record<CatalogView, { kind: string; title: string; add: string; unit: string; categoryHint: string | null }> = {
  menu: { kind: 'menu', title: 'Menu', add: 'Add dish or drink', unit: 'plate', categoryHint: 'e.g. Breakfast, Main dishes, Hot drinks, Juices' },
  products: { kind: 'item', title: 'Products & stock', add: 'Add product', unit: 'pcs', categoryHint: 'e.g. Rice & flour, Cooking oil, Soft drinks' },
  fuels: { kind: 'fuel', title: 'Fuel types & prices', add: 'Add fuel type', unit: 'L', categoryHint: null },
};
const MOVE_LABEL: Record<string, string> = {
  opening: 'Opening stock', purchase: 'Purchase', purchase_void: 'Purchase cancelled', sale: 'Sale', sale_void: 'Sale cancelled', sale_return: 'Customer return',
  usage: 'Kitchen usage', waste: 'Waste / damage', adjustment: 'Count correction', fuel_sale: 'Pump sales', fuel_sale_void: 'Pump sales cancelled', tank_dip: 'Tank dip variance',
};

export function StockPage({ view }: { view: CatalogView }) {
  const { business, can } = useAuth();
  const v = VIEW[view];
  const kind = v.kind;
  const menu = view === 'menu';   // the restaurant menu: no stock, just pictures and prices
  const [tab, setTab] = useState('products');
  const [search, setSearch] = useState('');
  const products = useLoad(() => get('/products', { business, stats: '1' }), [business]);
  const moves = useLoad(() => (tab === 'history' ? get('/stock/movements', { business }) : Promise.resolve(null)), [business, tab]);
  const moveFilter = useFilters<any>(moves.data ?? [], [
    { key: 'what', label: 'What', get: (m) => MOVE_LABEL[m.type] ?? m.type },
    { key: 'by', label: 'Recorded by', get: (m) => m.created_by_name },
  ], (m) => `${m.product_name} ${m.reason ?? ''} ${m.created_by_name}`, 'Search item, reason, person');
  const [edit, setEdit] = useState<any>(null);
  const [adjust, setAdjust] = useState<any>(null);

  const all = (products.data ?? []).filter((p: any) => p.kind === kind);
  // Category suggestions come only from this business's own items of this kind.
  const categories = [...new Set(all.map((p: any) => p.category).filter(Boolean))] as string[];
  const rows = all.filter((p: any) => !search || `${p.name} ${p.category} ${p.sku ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const value = rows.reduce((s: number, p: any) => s + (p.track_stock ? p.stock_value : 0), 0);
  const low = rows.filter((p: any) => p.active && p.track_stock && p.kind !== 'fuel' && (p.stock_qty <= 0 || p.stock_qty <= p.reorder_level)).length;

  return (
    <div className="module-page">
      <PageHeader icon={<PackageSearch size={22} />} title={v.title}
        subtitle={menu ? `${rows.filter((p: any) => p.active).length} items on the menu` : `Stock value ${money(value)} at cost · ${low} items low or out of stock`}
        actions={can('catalog') && <button type="button" className="btn btn-primary" onClick={() => setEdit({})}><Plus size={16} /> {v.add}</button>} />
      <div className="panel">
        {!menu && <Tabs tabs={[{ key: 'products', label: 'Items' }, { key: 'history', label: 'Stock history' }]} activeTab={tab} onTabChange={setTab} />}
        <ErrorBox error={products.error} />
        {tab === 'products' ? (
          <>
            <input className="form-input" style={{ maxWidth: 300, marginBottom: 12 }} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
            {kind === 'fuel' && <div className="mc-note" style={{ marginBottom: 12 }}>Fuel stock is kept per tank: record deliveries in Deliveries and tank dips in Pumps &amp; Shifts. Change the price per litre here.</div>}
            <div className="table-wrap">
              <table>
                {menu ? (
                  <>
                    <thead><tr><th>Item</th><th className="num">Price</th><th className="num">Sold 30 days</th><th></th></tr></thead>
                    <tbody>
                      {rows.map((p: any) => (
                        <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
                          <td><div className="row" style={{ flexWrap: 'nowrap', gap: 10 }}><ItemPicture item={p} size={40} />
                            <div><strong>{p.name}</strong>{!p.active && <span className="small muted"> (hidden)</span>}{p.category && <div className="small muted">{p.category}</div>}</div></div></td>
                          <td className="num">{money(p.sale_price)}</td>
                          <td className="num">{num(p.sold_30d)}</td>
                          <td style={{ textAlign: 'right' }}>{can('catalog') && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEdit(p)}>Edit</button>}</td>
                        </tr>
                      ))}
                      {!products.loading && !rows.length && <tr><td colSpan={4} className="muted">No items yet. Add your dishes and drinks with a picture and price.</td></tr>}
                    </tbody>
                  </>
                ) : (<>
                <thead><tr><th>Item</th><th>Type</th><th className="num">Selling price</th><th className="num">In stock</th><th className="num">Avg cost</th><th className="num">Stock value</th><th className="num">Sold 30 days</th><th></th></tr></thead>
                <tbody>
                  {rows.map((p: any) => {
                    const isLow = p.track_stock && p.kind !== 'fuel' && (p.stock_qty <= 0 || p.stock_qty <= p.reorder_level);
                    return (
                      <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
                        <td><div className="row" style={{ flexWrap: 'nowrap', gap: 10 }}>{view === 'products' && <ItemPicture item={p} size={36} />}
                          <div><strong>{p.name}</strong>{p.category && <div className="small muted">{p.category}</div>}</div></div></td>
                        <td className="small">{KIND_LABEL[p.kind]}{!p.active && ' (hidden)'}</td>
                        <td className="num">{p.kind === 'ingredient' ? '—' : money(p.sale_price)}{p.kind === 'fuel' && ' /L'}</td>
                        <td className="num">{p.track_stock ? <>{num(p.stock_qty)} {p.unit} {isLow && <StatusBadge label={p.stock_qty <= 0 ? 'Out' : 'Low'} tone={p.stock_qty <= 0 ? 'red' : 'yellow'} />}</>
                          : <span className="muted">not tracked</span>}</td>
                        <td className="num">{p.track_stock ? money(Math.round(p.avg_cost)) : '—'}</td>
                        <td className="num">{p.track_stock ? <Money c={p.stock_value} /> : '—'}</td>
                        <td className="num">{p.kind === 'ingredient' || p.kind === 'fuel' ? '—' : num(p.sold_30d)}</td>
                        <td>
                          <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                            {p.track_stock && p.kind !== 'fuel' && (can('stock') || can('catalog')) && p.active ? (
                              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setAdjust(p)}>{p.kind === 'ingredient' ? 'Use / waste' : 'Waste / count'}</button>
                            ) : null}
                            {can('catalog') && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEdit(p)}>Edit</button>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {!products.loading && !rows.length && <tr><td colSpan={8} className="muted">No items yet.</td></tr>}
                </tbody>
                </>)}
              </table>
            </div>
          </>
        ) : (
          <>{moveFilter.bar}<div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Item</th><th>What</th><th className="num">Qty</th><th className="num">Value</th><th>Reason</th><th>Recorded by</th></tr></thead>
              <tbody>
                {moveFilter.shown.map((m: any) => (
                  <tr key={m.id}>
                    <td className="small">{m.entry_date}<div className="muted">{fmtTime(m.created_at)}</div></td>
                    <td>{m.product_name}{m.tank_name && <div className="small muted">{m.tank_name}</div>}</td>
                    <td>{MOVE_LABEL[m.type] ?? m.type}</td>
                    <td className="num" style={{ color: m.qty < 0 ? '#b91c1c' : '#15803d' }}>{m.qty > 0 ? '+' : ''}{num(m.qty)} {m.unit}</td>
                    <td className="num"><Money c={m.value} /></td>
                    <td className="small">{m.reason}</td>
                    <td className="small"><strong>{m.created_by_name}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></>
        )}
      </div>

      {edit && <ProductModal product={edit} view={view} categories={categories} onClose={() => setEdit(null)} onDone={() => { setEdit(null); products.reload(); }} />}
      {adjust && <AdjustModal product={adjust} onClose={() => setAdjust(null)} onDone={() => { setAdjust(null); products.reload(); moves.reload(); }} />}
    </div>
  );
}

function ProductModal({ product, view, categories, onClose, onDone }: { product: any; view: CatalogView; categories: string[]; onClose: () => void; onDone: () => void }) {
  const { business } = useAuth();
  const { addToast } = useToast();
  const v = VIEW[view];
  const isNew = !product.id;
  const [f, setF] = useState({
    name: product.name ?? '', category: product.category ?? '', kind: product.kind ?? v.kind, unit: product.unit ?? v.unit,
    sku: product.sku ?? '', salePrice: product.sale_price !== undefined ? fromCents(product.sale_price) : '', trackStock: product.track_stock ?? (v.kind === 'menu' ? 0 : 1),
    reorderLevel: String(product.reorder_level ?? ''), openingQty: '', openingCost: '', priceReason: '', active: product.active ?? 1,
  });
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const prices = useLoad(() => (isNew ? Promise.resolve([]) : get(`/products/${product.id}/prices`)), [product.id]);
  const { run, busy } = useSubmit();
  const priceChanged = !isNew && toCents(f.salePrice) !== product.sale_price;
  const tracked = f.kind !== 'menu';   // restaurant menu items are not stock-counted

  const save = async () => {
    const body = {
      business, name: f.name, category: f.category, kind: f.kind, unit: f.unit, sku: f.sku, salePrice: toCents(f.salePrice),
      trackStock: f.kind !== 'menu', reorderLevel: Number(f.reorderLevel) || 0, active: Boolean(f.active),
      openingQty: Number(f.openingQty) || 0, openingCost: toCents(f.openingCost), priceReason: f.priceReason,
    };
    const r = await run(async (key) => {
      const saved = await (isNew ? post('/products', body, key) : patch(`/products/${product.id}`, body));
      if (picture !== undefined) await post(`/products/${saved.id}/image`, { data: picture });
      return saved;
    }, 'Saved');
    if (r) onDone();
  };
  // undefined = unchanged, null = remove, string = new picture (data URL)
  const [picture, setPicture] = useState<string | null | undefined>(undefined);
  const showPictures = v.kind === 'menu' || v.kind === 'item';

  return (
    <Modal open onClose={onClose} title={isNew ? v.add : `Edit ${product.name}`} width="md"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !f.name.trim()} onClick={save}>Save</button></>}>
      <div className="form-stack">
        <div className={v.categoryHint ? 'form-row' : ''}>
          <Field label={view === 'fuels' ? 'Fuel name (e.g. Diesel, Petrol)' : 'Name'}><input className="form-input" value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
          {v.categoryHint && (
            <Field label="Category">
              <input className="form-input" list={`categories-${view}`} value={f.category} onChange={(e) => set('category', e.target.value)} placeholder={v.categoryHint} />
              <datalist id={`categories-${view}`}>{categories.map((c) => <option key={c} value={c} />)}</datalist>
            </Field>
          )}
        </div>
        <div className="form-row-3">
          {f.kind !== 'ingredient' && <Field label={f.kind === 'fuel' ? 'Price per litre' : 'Selling price'}><MoneyInput value={f.salePrice} onChange={(v) => set('salePrice', v)} /></Field>}
          <Field label="Unit"><input className="form-input" value={f.unit} onChange={(e) => set('unit', e.target.value)} placeholder="pcs, kg, L" /></Field>
          {f.kind !== 'fuel' && <Field label="Barcode / code"><input className="form-input" value={f.sku} onChange={(e) => set('sku', e.target.value)} /></Field>}
        </div>
        {showPictures && (
          <Field label="Picture (shown on the till)">
            <div className="row">
              {picture ? <img className="item-pic" src={picture} alt="" style={{ width: 64, height: 64 }} />
                : picture === undefined && product.image_v ? <ItemPicture item={product} size={64} />
                : <ItemPicture item={{ name: f.name || product.name || '' }} size={64} />}
              <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                {product.image_v || picture ? 'Change photo' : 'Add photo'}
                <input type="file" accept="image/*" hidden onChange={async (e) => {
                  const file = e.target.files?.[0]; e.target.value = '';
                  if (file) { try { setPicture(await shrinkPicture(file)); } catch { addToast('error', 'Could not read this picture. Try a JPG or PNG photo.', 4000); } }
                }} />
              </label>
              {(picture || (picture === undefined && product.image_v)) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicture(null)}>Remove</button>}
              {!picture && !product.image_v && <span className="small muted">No photo yet: an icon is shown instead.</span>}
            </div>
          </Field>
        )}
        {priceChanged && <Field label="Why is the price changing? (saved in price history)"><input className="form-input" value={f.priceReason} onChange={(e) => set('priceReason', e.target.value)} /></Field>}
        {tracked && f.kind !== 'fuel' && <Field label="Warn me when stock falls to"><input className="form-input" inputMode="decimal" value={f.reorderLevel} onChange={(e) => set('reorderLevel', e.target.value)} /></Field>}
        {isNew && tracked && f.kind !== 'fuel' && (
          <div className="form-row">
            <Field label="Quantity in stock now"><input className="form-input" inputMode="decimal" value={f.openingQty} onChange={(e) => set('openingQty', e.target.value)} /></Field>
            <Field label="Cost per unit"><MoneyInput value={f.openingCost} onChange={(v) => set('openingCost', v)} /></Field>
          </div>
        )}
        {!isNew && <label className="row"><input type="checkbox" checked={Boolean(f.active)} onChange={(e) => set('active', e.target.checked ? 1 : 0)} /> Active (uncheck to hide from selling)</label>}
        {!isNew && (prices.data?.length ?? 0) > 0 && (
          <div>
            <strong className="small">Price history</strong>
            <table><tbody>{prices.data!.map((p: any) => (
              <tr key={p.id}><td className="small">{fmtTime(p.changed_at)}</td><td className="small">{money(p.old_price)} → {money(p.new_price)}</td><td className="small muted">{p.changed_by_name}{p.reason ? ` · ${p.reason}` : ''}</td></tr>
            ))}</tbody></table>
          </div>
        )}
      </div>
    </Modal>
  );
}

function AdjustModal({ product, onClose, onDone }: { product: any; onClose: () => void; onDone: () => void }) {
  const { can, today } = useAuth();
  const types = [
    ...(product.kind === 'ingredient' ? [['usage', 'Used in the kitchen']] : []),
    ['waste', 'Wasted, damaged or missing'],
    ...(can('catalog') ? [['adjustment', 'Correct the count (stock taking)']] : []),
  ];
  const [type, setType] = useState(types[0][0]);
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today);
  const { run, busy } = useSubmit();
  const change = type === 'adjustment' ? (Number(qty) || 0) - product.stock_qty : -(Number(qty) || 0);

  const save = async () => {
    const r = await run((key) => post('/stock/adjust', { product: product.id, type, qty: Number(qty), countedQty: Number(qty), reason, date }, key), 'Stock updated');
    if (r) onDone();
  };
  return (
    <Modal open onClose={onClose} title={product.name} width="sm"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || qty === '' || (type !== 'usage' && !reason.trim())} onClick={save}>Save</button></>}>
      <div className="form-stack">
        <p className="muted">In stock now: <strong>{num(product.stock_qty)} {product.unit}</strong> (cost {money(Math.round(product.avg_cost))} each)</p>
        <Field label="What happened">
          <select className="form-select" value={type} onChange={(e) => setType(e.target.value)}>
            {types.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <div className="form-row">
          <Field label={type === 'adjustment' ? `Counted quantity (${product.unit})` : `Quantity (${product.unit})`}>
            <input className="form-input" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
          </Field>
          <Field label="Date"><input type="date" className="form-input" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        {qty !== '' && <div className={change < 0 ? 'mc-warn' : 'mc-note'}>Stock change {change > 0 ? '+' : ''}{num(change)} {product.unit} · value {money(Math.round(change * product.avg_cost))}
          {type === 'usage' ? ' (counted as cost of food sold)' : ' (counted as a loss)'}</div>}
        <Field label={type === 'usage' ? 'Note (optional)' : 'Reason (required)'}><input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
