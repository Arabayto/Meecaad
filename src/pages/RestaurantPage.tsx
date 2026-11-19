// Restaurant & Cafe till — everything on one page: tap the menu, then either
// Pay now or Send to the kitchen and pay later; open orders sit at the top
// (tap one to add items or take its payment); today's sales are underneath.
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Minus, Plus, Printer, Send, Trash2, X } from 'lucide-react';
import { fromCents, get, money, num, patch, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { SaleReceipt } from '../components/Receipt';
import { ErrorBox, Field, MoneyInput, PartySelect, PaymentsEditor, ReasonModal, useLoad, usePolling, useSubmit, type PayLine } from '../components/ui';
import { SalesPage } from './SalesPage';

// A picture for items that have none yet, guessed from the name.
const EMOJI: [RegExp, string][] = [
  [/samb|samos/i, '🥟'], [/shaah|chai|\btea\b|shah/i, '🍵'], [/coffee|qaxwo|bun|espresso|latte|cappu/i, '☕'], [/juice|cabitaan|mango|orange|lemon/i, '🧃'],
  [/water|biyo/i, '💧'], [/soda|cola|fanta|sprite|7up|pepsi/i, '🥤'], [/milk|caano/i, '🥛'], [/rice|bariis/i, '🍚'], [/pasta|baasto|spaghetti/i, '🍝'],
  [/chicken|digaag/i, '🍗'], [/meat|hilib|beef|goat|camel|geel|steak/i, '🍖'], [/fish|kalluun/i, '🐟'], [/burger/i, '🍔'], [/pizza/i, '🍕'],
  [/sandwich|sandwij/i, '🥪'], [/bread|rooti|muufo|canjeero|laxoox|anjero/i, '🫓'], [/egg|ukun/i, '🍳'], [/salad|salaad/i, '🥗'], [/cake|keeg|sweet|xalwo/i, '🍰'],
  [/fries|chips|baradho/i, '🍟'], [/soup|maraq/i, '🍲'], [/banana|moos/i, '🍌'], [/ice ?cream/i, '🍨'],
];
export const itemEmoji = (name: string) => EMOJI.find(([re]) => re.test(name))?.[1] ?? '🍽️';

export function ItemPicture({ item, size = 64 }: { item: any; size?: number }) {
  return item.image_v
    ? <img className="item-pic" src={`/api/products/${item.id}/image?v=${encodeURIComponent(item.image_v)}`} alt="" style={{ width: size, height: size }} loading="lazy" />
    : <span className="item-pic item-pic--emoji" style={{ width: size, height: size, fontSize: size * 0.55 }}>{itemEmoji(item.name)}</span>;
}

const since = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};
const orderTitle = (o: any) => `#${o.number ?? '—'}${o.table_name ? ` · ${o.table_name}` : ''}${o.label ? ` · ${o.label}` : ''}`;

// ── The till ────────────────────────────────────────────────────
type Lines = Record<string, number>;
interface Draft { lines: Lines; table: string; label: string; note: string }
const emptyDraft = (): Draft => ({ lines: {}, table: '', label: '', note: '' });
const DRAFT = 'mc_restaurant_draft';
function loadDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT) ?? 'null');
    if (d && typeof d.lines === 'object') return { ...emptyDraft(), ...d };
  } catch { /* storage unavailable */ }
  return emptyDraft();
}
const sameLines = (a: Lines, b: Lines) => {
  const ka = Object.keys(a).filter((k) => a[k] > 0), kb = Object.keys(b).filter((k) => b[k] > 0);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

export function RestaurantPOS() {
  const { today, activeMethods } = useAuth();
  const products = useLoad(() => get('/products', { business: 'restaurant' }), []);
  const tables = useLoad(() => get('/restaurant/tables'), []);
  const orders = useLoad(() => get('/restaurant/orders'), []);
  const customers = useLoad(() => get('/customers', { business: 'restaurant' }), []);
  usePolling(orders.reload, 10000);

  // The new order being taken (kept on this device if the page reloads) …
  const [draft, setDraft] = useState<Draft>(loadDraft);
  useEffect(() => { try { localStorage.setItem(DRAFT, JSON.stringify(draft)); } catch { /* storage unavailable */ } }, [draft]);
  // … or an open order picked from the top (its items can be changed before paying).
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft | null>(null);
  const order = openId ? (orders.data ?? []).find((o: any) => o.id === openId) ?? null : null;
  const cur = order && edit ? edit : draft;
  const setCur = (fn: (d: Draft) => Draft) => (order ? setEdit((e) => fn(e ?? emptyDraft())) : setDraft(fn));

  // Payment: one tap on the method; discount, split and cash-given only when needed.
  const [method, setMethod] = useState('cash');
  const [customer, setCustomer] = useState('');
  const [discount, setDiscount] = useState('');
  const [showDiscount, setShowDiscount] = useState(false);
  const [split, setSplit] = useState<PayLine[] | null>(null);
  const [given, setGiven] = useState('');
  const resetPay = () => { setMethod('cash'); setCustomer(''); setDiscount(''); setShowDiscount(false); setSplit(null); setGiven(''); };

  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [done, setDone] = useState<{ text: string; sale?: any; ticket?: any } | null>(null);
  const [printing, setPrinting] = useState<{ sale?: any; ticket?: any } | null>(null);
  const [cancelling, setCancelling] = useState<any>(null);
  const [saved, setSaved] = useState(0);
  const { run, busy } = useSubmit();

  const menu = (products.data ?? []).filter((p: any) => p.kind === 'menu' && p.active);
  const categories = [...new Set(menu.map((p: any) => p.category).filter(Boolean))] as string[];
  const shown = menu.filter((p: any) => (!category || p.category === category) && (!search || p.name.toLowerCase().includes(search.toLowerCase())));
  const chosen = Object.keys(cur.lines).filter((id) => cur.lines[id] > 0).map((id) => {
    const p: any = menu.find((m: any) => m.id === id);
    const i: any = order?.items.find((x: any) => x.product_id === id);
    return p ?? (i ? { id, name: i.name, sale_price: i.sale_price } : null);
  }).filter(Boolean) as any[];
  const subtotal = useMemo(() => chosen.reduce((s: number, p: any) => s + Math.round(cur.lines[p.id] * p.sale_price), 0), [chosen, cur.lines]);
  const total = Math.max(0, subtotal - toCents(discount));
  const count = chosen.reduce((s: number, p: any) => s + cur.lines[p.id], 0);
  const payments: PayLine[] = split ?? (method === 'credit' ? [] : [{ method, amount: total ? fromCents(total) : '' }]);
  const paid = payments.reduce((s, p) => s + toCents(p.amount), 0);
  const unpaid = total - paid;
  const cashIn = toCents(payments.find((p) => p.method === 'cash')?.amount ?? 0);
  const origLines: Lines = order ? Object.fromEntries(order.items.map((i: any) => [i.product_id, i.qty])) : {};
  const changed = Boolean(order && edit && !sameLines(edit.lines, origLines));
  const tableName = (id: string) => (tables.data ?? []).find((t: any) => t.id === id)?.name;

  const add = (id: string, d: number) => setCur((c) => ({ ...c, lines: { ...c.lines, [id]: Math.max(0, Math.round(((c.lines[id] ?? 0) + d) * 1000) / 1000) } }));
  const pick = (o: any | null) => {
    setOpenId(o?.id ?? null);
    setEdit(o ? { lines: Object.fromEntries(o.items.map((i: any) => [i.product_id, i.qty])), table: o.table_id ?? '', label: o.label ?? '', note: o.note ?? '' } : null);
    resetPay(); setDone(null);
  };
  // An open order that was paid or cancelled elsewhere: back to a new order.
  useEffect(() => { if (openId && orders.data && !order) { setOpenId(null); setEdit(null); } }, [openId, orders.data, order]);

  const items = () => chosen.map((p: any) => ({ product: p.id, qty: cur.lines[p.id] }));
  const ticketOf = (number: number | undefined, d: Draft) => ({ number, table: tableName(d.table), label: d.label, note: d.note, items: chosen.map((p: any) => ({ name: p.name, qty: d.lines[p.id] })) });
  const finished = () => { resetPay(); orders.reload(); tables.reload(); customers.reload(); setSaved((n) => n + 1); };
  const pay = { date: today, customer: customer || undefined, discount: toCents(discount), payments: payments.map((p) => ({ method: p.method, amount: toCents(p.amount) })) };

  const payNow = async () => {
    const r: any = await run((key) => (order
      ? post(`/restaurant/orders/${order.id}/pay`, { ...pay, items: changed ? items() : undefined }, key)
      : post('/restaurant/orders', { items: items(), table: cur.table || undefined, label: cur.label, note: cur.note, pay }, key)));
    if (!r) return;
    const saleId = order ? r.id : r.sale;
    const label = order ? `Order #${order.number}` : `Order #${r.number}`;
    const ticket = ticketOf(order?.number ?? r.number, cur);
    if (order) { setOpenId(null); setEdit(null); } else setDraft(emptyDraft());
    finished();
    const sale = await get(`/sales/${saleId}`).catch(() => null);
    setDone({ text: `${label} paid · ${money(sale?.total ?? total)}`, sale, ticket });
  };
  const send = async () => {
    const r: any = await run((key) => (order
      ? patch(`/restaurant/orders/${order.id}`, { items: items(), table: cur.table || null, label: cur.label, note: cur.note })
      : post('/restaurant/orders', { items: items(), table: cur.table || undefined, label: cur.label, note: cur.note }, key)));
    if (!r) return;
    const number = order?.number ?? r.number;
    setDone({ text: `Order #${number} ${order ? 'updated' : 'sent to the kitchen'} — pay later from the top`, ticket: ticketOf(number, cur) });
    if (order) { setOpenId(null); setEdit(null); } else setDraft(emptyDraft());
    finished();
  };
  const clear = () => { setDraft(emptyDraft()); resetPay(); };

  const open = orders.data ?? [];
  const openTotal = open.reduce((s: number, o: any) => s + o.total, 0);
  const freeTables = (tables.data ?? []).filter((t: any) => t.active && (!t.order_id || t.order_id === openId));
  const blocked = busy || !chosen.length || unpaid < 0 || (unpaid > 0 && !customer);

  return (
    <div className="module-page">
      <ErrorBox error={products.error ?? orders.error} />

      {/* Open orders: tap one to add items or take its payment */}
      <div className="panel rpos-orders">
        <div className="rpos-orders__head"><strong>Open orders</strong><span className="muted small">{open.length ? `${open.length} not paid · ${money(openTotal)}` : 'none — orders sent to the kitchen wait here until paid'}</span></div>
        <div className="rpos-chips">
          <button type="button" className={`rpos-chip rpos-chip--new ${!order ? 'active' : ''}`} onClick={() => pick(null)}>
            <Plus size={14} /> New order{draft && Object.values(draft.lines).some((q) => q > 0) ? <span className="rpos-chip__badge">{num(Object.values(draft.lines).reduce((a, b) => a + b, 0))}</span> : null}
          </button>
          {open.map((o: any) => (
            <button key={o.id} type="button" className={`rpos-chip ${openId === o.id ? 'active' : ''}`} onClick={() => pick(o)}>
              <strong>#{o.number}</strong>
              <span className="rpos-chip__who">{o.table_name ?? o.label ?? o.items.map((i: any) => `${num(i.qty)} ${i.name}`).join(', ')}</span>
              <span className="rpos-chip__amt">{money(o.total)}</span>
              <span className="rpos-chip__age">{since(o.created_at)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="pos">
        {/* Menu */}
        <div className="panel">
          <div className="row" style={{ marginBottom: 10 }}>
            <input className="form-input" style={{ flex: 1 }} placeholder="Search the menu" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {categories.length > 1 && (
            <div className="scope-tabs" style={{ marginBottom: 10 }}>
              <button type="button" className={!category ? 'active' : ''} onClick={() => setCategory('')}>All</button>
              {categories.map((c) => <button key={c} type="button" className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>{c}</button>)}
            </div>
          )}
          <div className="menu-grid menu-grid--compact">
            {shown.map((p: any) => (
              <div key={p.id} className={`menu-tile ${cur.lines[p.id] ? 'menu-tile--on' : ''}`}>
                <button type="button" className="menu-tile__main" onClick={() => add(p.id, 1)}>
                  <ItemPicture item={p} size={52} />
                  <strong>{p.name}</strong>
                  <span className="price">{money(p.sale_price)}</span>
                </button>
                {cur.lines[p.id] > 0 && <span className="menu-tile__count">{num(cur.lines[p.id])}</span>}
              </div>
            ))}
          </div>
          {!products.loading && !menu.length && <div className="mc-note">No dishes or drinks yet. Add them in Menu.</div>}
        </div>

        {/* The order and its payment */}
        <div className="panel pos-cart rpos-cart">
          {done && (
            <div className="rpos-done">
              <CheckCircle2 size={18} />
              <span>{done.text}</span>
              {done.sale && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setPrinting({ sale: done.sale })}><Printer size={13} /> Receipt</button>}
              {done.ticket && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setPrinting({ ticket: done.ticket })}><Printer size={13} /> Kitchen</button>}
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setDone(null)} aria-label="Hide"><X size={13} /></button>
            </div>
          )}
          <div className="row row--between">
            <h2 style={{ margin: 0, fontSize: 17 }}>{order ? `Order #${order.number}` : 'New order'}</h2>
            {order
              ? <span className="small muted">{since(order.created_at)} · by {order.created_by_name}</span>
              : chosen.length > 0 && <button type="button" className="btn btn-ghost btn-xs" onClick={clear}><Trash2 size={13} /> Clear</button>}
          </div>

          {chosen.length === 0 ? <p className="muted" style={{ margin: 0 }}>Tap the menu to add items. Then <strong>Pay</strong> now, or <strong>Send to kitchen</strong> and pay later from the open orders above.</p> : (
            <div>
              {chosen.map((p: any) => (
                <div className="cart-line" key={p.id}>
                  <div><strong>{p.name}</strong><div className="muted small">{money(p.sale_price)} each</div></div>
                  <div className="qty-box">
                    <button type="button" onClick={() => add(p.id, -1)} aria-label={`One less ${p.name}`}><Minus size={14} /></button>
                    <span className="qty-box__n">{num(cur.lines[p.id])}</span>
                    <button type="button" onClick={() => add(p.id, 1)} aria-label={`One more ${p.name}`}><Plus size={14} /></button>
                  </div>
                  <div className="num">{money(Math.round(cur.lines[p.id] * p.sale_price))}</div>
                </div>
              ))}
            </div>
          )}

          <details className="rpos-more" open={Boolean(cur.table || cur.label || cur.note) || undefined}>
            <summary>Table, name, note for the kitchen{cur.table || cur.label ? ` — ${[tableName(cur.table), cur.label].filter(Boolean).join(' · ')}` : ''}</summary>
            <div className="form-row">
              <Field label="Table">
                <select className="form-select" value={cur.table} onChange={(e) => setCur((c) => ({ ...c, table: e.target.value }))}>
                  <option value="">No table</option>
                  {freeTables.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
              <Field label="Name"><input className="form-input" value={cur.label} onChange={(e) => setCur((c) => ({ ...c, label: e.target.value }))} placeholder="e.g. Ali, takeaway" /></Field>
            </div>
            <Field label="Note"><input className="form-input" value={cur.note} onChange={(e) => setCur((c) => ({ ...c, note: e.target.value }))} placeholder="e.g. no sugar in 2 teas" /></Field>
          </details>

          {chosen.length > 0 && (
            <div className="rpos-pay">
              <div className="cart-total"><span>{num(count)} items{toCents(discount) > 0 ? ` · −${money(toCents(discount))}` : ''}</span><span>{money(total)}</span></div>
              {!split && (
                <div className="method-picker">
                  {activeMethods.map((m) => <button key={m.id} type="button" className={`btn ${method === m.id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMethod(m.id)}>{m.name}</button>)}
                  <button type="button" className={`btn ${method === 'credit' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMethod('credit')}>On credit</button>
                </div>
              )}
              {split && <PaymentsEditor value={split} total={total} onChange={setSplit} />}
              {cashIn > 0 && !split && (
                <div className="rpos-change">
                  <Field label="Cash given"><MoneyInput value={given} onChange={setGiven} /></Field>
                  <div><span className="muted small">Change</span><strong>{money(Math.max(0, toCents(given) - cashIn))}</strong></div>
                </div>
              )}
              {unpaid > 0 && (
                <Field label={method === 'credit' && !split ? 'Customer who owes it' : `Customer who owes ${money(unpaid)}`}>
                  <PartySelect kind="customers" value={customer} onChange={setCustomer} items={customers.data ?? []} onCreated={customers.reload} placeholder="Choose the customer…" />
                </Field>
              )}
              {unpaid < 0 && <div className="mc-error">Payments are more than the total. Enter only the amount kept.</div>}
              {showDiscount && <Field label="Discount"><MoneyInput value={discount} onChange={setDiscount} /></Field>}
              <div className="rpos-links">
                {!showDiscount && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setShowDiscount(true)}>+ Discount</button>}
                {split
                  ? <button type="button" className="btn btn-ghost btn-xs" onClick={() => setSplit(null)}>One payment method</button>
                  : <button type="button" className="btn btn-ghost btn-xs" onClick={() => setSplit([{ method: method === 'credit' ? 'cash' : method, amount: fromCents(total) }])}>Split payment</button>}
              </div>
            </div>
          )}

          {chosen.length > 0 && <button type="button" className="btn btn-primary btn-block rpos-paybtn" disabled={blocked} onClick={payNow}>
            {busy ? 'Saving…' : unpaid > 0 && paid === 0 ? `Save ${money(total)} on credit` : `Pay ${money(paid)}${unpaid > 0 ? ` · ${money(unpaid)} on credit` : ''}`}
          </button>}
          {chosen.length > 0 && (!order || changed) && (
            <button type="button" className="btn btn-secondary btn-block" disabled={busy || !chosen.length} onClick={send}>
              <Send size={16} /> {order ? 'Save changes — pay later' : 'Send to kitchen — pay later'}
            </button>
          )}
          {order && (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setPrinting({ ticket: ticketOf(order.number, cur) })}><Printer size={12} /> Kitchen ticket</button>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setCancelling(order)}>Cancel order</button>
            </div>
          )}
        </div>
      </div>

      {/* Today's sales underneath */}
      <SalesPage embedded refreshKey={saved} />

      {/* Phones: the total and Pay stay in reach while scrolling the menu. */}
      {chosen.length > 0 && (
        <div className="order-bar no-print">
          <button type="button" className="order-bar__summary" onClick={() => document.querySelector('.rpos-cart')?.scrollIntoView({ behavior: 'smooth' })}>
            <strong>{num(count)} items · {money(total)}</strong><span>{order ? `Order #${order.number}` : 'Payment & send'}</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={() => document.querySelector('.rpos-pay')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>Pay / send</button>
        </div>
      )}

      {cancelling && <ReasonModal open onClose={() => setCancelling(null)} title={`Cancel order ${orderTitle(cancelling)}?`} action={`/restaurant/orders/${cancelling.id}/cancel`}
        confirmLabel="Cancel order" message="Nothing was paid yet, so money does not change. The cancellation is recorded." onDone={() => { pick(null); orders.reload(); tables.reload(); }} />}
      <Modal open={Boolean(printing)} onClose={() => setPrinting(null)} title={printing?.sale ? 'Receipt' : 'Kitchen ticket'} width="sm"
        footer={<button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print</button>}>
        {printing?.sale && <SaleReceipt sale={printing.sale} />}
        {printing?.ticket && <KitchenTicket order={printing.ticket} />}
      </Modal>
    </div>
  );
}

/** Printable ticket for the kitchen. */
function KitchenTicket({ order }: { order: any }) {
  return (
    <div className="receipt print-area kitchen-ticket">
      <h3>ORDER #{order.number ?? '—'}</h3>
      {(order.table || order.label) && <p className="center">{[order.table, order.label].filter(Boolean).join(' · ')}</p>}
      <hr />
      {order.items.map((i: any, k: number) => <p key={k} className="ticket-line"><strong>{num(i.qty)} ×</strong> {i.name}</p>)}
      {order.note && <><hr /><p><strong>Note:</strong> {order.note}</p></>}
      <hr />
      <p className="center small">{new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</p>
    </div>
  );
}
