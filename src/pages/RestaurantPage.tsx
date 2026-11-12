// Restaurant & Cafe POS: the waiter taps pictures to build an order and sends it
// (Pending). When the customer pays, the cashier takes the payment and the
// order becomes a sale.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardList, Minus, Plus, Printer, Send, Trash2 } from 'lucide-react';
import { fromCents, get, money, num, patch, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { SaleReceipt } from '../components/Receipt';
import { ErrorBox, Field, MoneyInput, PageHeader, PartySelect, PaymentsEditor, ReasonModal, useLoad, useSubmit, type PayLine } from '../components/ui';

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

/** Reload every few seconds while the page is visible, so phones and the kitchen screen stay in step. */
function usePolling(reload: () => void, ms: number) {
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') reload(); }, ms);
    return () => clearInterval(t);
  }, [reload, ms]);
}

const since = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};
const orderTitle = (o: any) => `#${o.number ?? '—'}${o.table_name ? ` · ${o.table_name}` : ''}${o.label ? ` · ${o.label}` : ''}`;

// ── New order ───────────────────────────────────────────────────
export function NewOrderPage() {
  const { path } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editId = params.get('order');
  const products = useLoad(() => get('/products', { business: 'restaurant' }), []);
  const tables = useLoad(() => get('/restaurant/tables'), []);
  const editing = useLoad(() => (editId ? get('/restaurant/orders').then((l: any[]) => l.find((o) => o.id === editId) ?? null) : Promise.resolve(null)), [editId]);
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<Record<string, number>>({});
  const [table, setTable] = useState('');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<any>(null);
  const { run, busy } = useSubmit();

  // Adding to an existing order: start from what it already has.
  useEffect(() => {
    const o = editing.data;
    if (o) { setLines(Object.fromEntries(o.items.map((i: any) => [i.product_id, i.qty]))); setTable(o.table_id ?? ''); setLabel(o.label ?? ''); setNote(o.note ?? ''); }
  }, [editing.data]);

  const menu = (products.data ?? []).filter((p: any) => p.kind === 'menu' && p.active);
  const categories = [...new Set(menu.map((p: any) => p.category).filter(Boolean))] as string[];
  const shown = menu.filter((p: any) => (!category || p.category === category) && (!search || p.name.toLowerCase().includes(search.toLowerCase())));
  // In the order the waiter tapped them.
  const chosen = Object.keys(lines).filter((id) => lines[id] > 0).map((id) => menu.find((p: any) => p.id === id)).filter(Boolean);
  const total = useMemo(() => chosen.reduce((s: number, p: any) => s + Math.round(lines[p.id] * p.sale_price), 0), [chosen, lines]);
  const count = chosen.reduce((s: number, p: any) => s + lines[p.id], 0);
  const add = (id: string, d: number) => setLines((l) => ({ ...l, [id]: Math.max(0, Math.round(((l[id] ?? 0) + d) * 1000) / 1000) }));
  const clear = () => { setLines({}); setTable(''); setLabel(''); setNote(''); };

  const send = async () => {
    const items = chosen.map((p: any) => ({ product: p.id, qty: lines[p.id] }));
    const r = await run((key) => (editId
      ? patch(`/restaurant/orders/${editId}`, { items, table: table || null, label, note }).then(() => ({ id: editId, number: editing.data?.number }))
      : post('/restaurant/orders', { items, table: table || undefined, label, note }, key)), editId ? 'Order updated' : 'Order sent to the kitchen');
    if (r) {
      setSent({ number: r.number, items: chosen.map((p: any) => ({ name: p.name, qty: lines[p.id] })), table: tables.data?.find((t: any) => t.id === table)?.name, label, note });
      clear(); tables.reload();
      if (editId) navigate(path('/order-list'));
    }
  };

  return (
    <div className="module-page">
      <ErrorBox error={products.error} />
      <div className="pos">
        <div className="panel">
          <div className="row" style={{ marginBottom: 12 }}>
            <input className="form-input" style={{ flex: 1 }} placeholder="Search the menu" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {categories.length > 1 && (
            <div className="scope-tabs" style={{ marginBottom: 12 }}>
              <button type="button" className={!category ? 'active' : ''} onClick={() => setCategory('')}>All</button>
              {categories.map((c) => <button key={c} type="button" className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>{c}</button>)}
            </div>
          )}
          <div className="menu-grid">
            {shown.map((p: any) => (
              <div key={p.id} className={`menu-tile ${lines[p.id] ? 'menu-tile--on' : ''}`}>
                <button type="button" className="menu-tile__main" onClick={() => add(p.id, 1)}>
                  <ItemPicture item={p} size={72} />
                  <strong>{p.name}</strong>
                  <span className="price">{money(p.sale_price)}</span>
                </button>
                {lines[p.id] > 0 && (
                  <div className="menu-tile__qty">
                    <button type="button" onClick={() => add(p.id, -1)} aria-label={`One less ${p.name}`}><Minus size={16} /></button>
                    <span>{num(lines[p.id])}</span>
                    <button type="button" onClick={() => add(p.id, 1)} aria-label={`One more ${p.name}`}><Plus size={16} /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {!products.loading && !menu.length && <div className="mc-note">No dishes or drinks yet. Add them (with a picture) in Menu.</div>}
        </div>

        <div className="panel pos-cart">
          <h2 style={{ margin: 0, fontSize: 17 }}>{editId ? `Order ${editing.data ? `#${editing.data.number}` : ''} — add or change items` : 'New order'}</h2>
          {chosen.length === 0 ? <p className="muted">Tap the pictures to add items.</p> : (
            <div>
              {chosen.map((p: any) => (
                <div className="cart-line" key={p.id}>
                  <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}><ItemPicture item={p} size={34} /><div><strong>{num(lines[p.id])} × {p.name}</strong><div className="muted small">{money(p.sale_price)} each</div></div></div>
                  <div className="qty-box">
                    <button type="button" onClick={() => add(p.id, -1)}>−</button>
                    <button type="button" onClick={() => add(p.id, 1)}>+</button>
                  </div>
                  <div className="num">{money(Math.round(lines[p.id] * p.sale_price))}</div>
                </div>
              ))}
            </div>
          )}
          <div className="form-row">
            <Field label="Table (optional)">
              <select className="form-select" value={table} onChange={(e) => setTable(e.target.value)}>
                <option value="">No table</option>
                {(tables.data ?? []).filter((t: any) => t.active && (!t.order_id || t.order_id === editId)).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Name (optional)"><input className="form-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Ali, takeaway" /></Field>
          </div>
          <Field label="Note for the kitchen (optional)"><input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. no sugar in 2 teas" /></Field>
          <div className="cart-total"><span>{count ? `${num(count)} items` : 'Total'}</span><span>{money(total)}</span></div>
          <button type="button" className="btn btn-primary btn-block" disabled={busy || !chosen.length} onClick={send}>
            <Send size={18} /> {busy ? 'Sending…' : editId ? 'Update order' : 'Send order'}
          </button>
          {chosen.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={clear}><Trash2 size={14} /> Clear</button>}
          <p className="small muted" style={{ margin: 0 }}>The order goes to the kitchen as <strong>Pending</strong>. Payment is taken later in Orders.</p>
        </div>
      </div>

      {/* Phones/tablets: the order total and Send button stay in reach while scrolling the menu. */}
      {chosen.length > 0 && (
        <div className="order-bar no-print">
          <button type="button" className="order-bar__summary" onClick={() => document.querySelector('.pos-cart')?.scrollIntoView({ behavior: 'smooth' })}>
            <strong>{num(count)} items · {money(total)}</strong><span>View order</span>
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={send}><Send size={16} /> {editId ? 'Update' : 'Send order'}</button>
        </div>
      )}

      <Modal open={Boolean(sent)} onClose={() => setSent(null)} title={sent?.number ? `Order #${sent.number} sent` : 'Order sent'} width="sm"
        footer={<>
          <button type="button" className="btn btn-secondary" onClick={() => navigate(path('/order-list'))}><ClipboardList size={16} /> See orders</button>
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}><Printer size={16} /> Print ticket</button>
          <button type="button" className="btn btn-primary" onClick={() => setSent(null)}>New order</button>
        </>}>
        {sent && <KitchenTicket order={sent} />}
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

// ── Orders (to serve and to pay) ────────────────────────────────
export function OrdersPage() {
  const { path } = useAuth();
  const navigate = useNavigate();
  const orders = useLoad(() => get('/restaurant/orders'), []);
  usePolling(orders.reload, 10000);
  const [paying, setPaying] = useState<any>(null);
  const [cancelling, setCancelling] = useState<any>(null);
  const [ticket, setTicket] = useState<any>(null);
  const [receipt, setReceipt] = useState<any>(null);
  const list = orders.data ?? [];
  const unpaid = (orders.data ?? []).reduce((s: number, o: any) => s + o.total, 0);

  return (
    <div className="module-page">
      <PageHeader icon={<ClipboardList size={22} />} title="Orders" subtitle={`${orders.data?.length ?? 0} open orders · ${money(unpaid)} not paid yet`}
        actions={<button type="button" className="btn btn-primary" onClick={() => navigate(path('/orders'))}><Plus size={16} /> New order</button>} />
      <ErrorBox error={orders.error} />
      {!orders.loading && !list.length && <div className="mc-note">No pending orders. New orders appear here automatically.</div>}
      <div className="orders-grid">
        {list.map((o: any) => (
          <div key={o.id} className="order-card">
            <div className="row row--between">
              <strong className="order-card__title">{orderTitle(o)}</strong>
              <StatusBadge label="Pending" tone="yellow" />
            </div>
            <div className="small muted">{since(o.created_at)} · by {o.created_by_name}</div>
            <ul className="order-card__items">
              {o.items.map((i: any) => <li key={i.id}><span>{num(i.qty)} × {i.name}</span><span>{money(Math.round(i.qty * i.sale_price))}</span></li>)}
            </ul>
            {o.note && <div className="small"><strong>Note:</strong> {o.note}</div>}
            <div className="cart-total" style={{ fontSize: 18 }}><span>Total</span><span>{money(o.total)}</span></div>
            <button type="button" className="btn btn-primary btn-block" onClick={() => setPaying(o)}>Pay {money(o.total)}</button>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => navigate(`${path('/orders')}?order=${o.id}`)}>Add items</button>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setTicket({ ...o, table: o.table_name })}><Printer size={12} /> Ticket</button>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setCancelling(o)}>Cancel</button>
            </div>
          </div>
        ))}
      </div>

      {paying && <PayModal order={paying} onClose={() => setPaying(null)} onPaid={async (saleId) => { setPaying(null); orders.reload(); setReceipt(await get(`/sales/${saleId}`)); }} />}
      {cancelling && <ReasonModal open onClose={() => setCancelling(null)} title={`Cancel order ${orderTitle(cancelling)}?`} action={`/restaurant/orders/${cancelling.id}/cancel`}
        confirmLabel="Cancel order" message="Nothing was paid yet, so money and stock do not change. The cancellation is recorded." onDone={orders.reload} />}
      <Modal open={Boolean(ticket)} onClose={() => setTicket(null)} title="Kitchen ticket" width="sm"
        footer={<button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print</button>}>
        {ticket && <KitchenTicket order={ticket} />}
      </Modal>
      <Modal open={Boolean(receipt)} onClose={() => setReceipt(null)} title="Paid" width="sm"
        footer={<>
          <button type="button" className="btn btn-secondary" onClick={() => setReceipt(null)}>Done</button>
          <button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print receipt</button>
        </>}>
        {receipt && <SaleReceipt sale={receipt} />}
      </Modal>
    </div>
  );
}

function PayModal({ order, onClose, onPaid }: { order: any; onClose: () => void; onPaid: (saleId: string) => void }) {
  const { today } = useAuth();
  const customers = useLoad(() => get('/customers', { business: 'restaurant' }), []);
  const [discount, setDiscount] = useState('');
  const [customer, setCustomer] = useState('');
  const [payLines, setPayLines] = useState<PayLine[]>([{ method: 'cash', amount: '' }]);
  const [touched, setTouched] = useState(false);
  const [given, setGiven] = useState('');
  const { run, busy } = useSubmit();
  const total = Math.max(0, order.total - toCents(discount));
  // Same rule as the till: one method covers the whole bill until the cashier types a different amount.
  const payments: PayLine[] = touched ? payLines : [{ method: payLines[0]?.method ?? 'cash', amount: total ? fromCents(total) : '' }];
  const paid = payments.reduce((s, p) => s + toCents(p.amount), 0);
  const credit = total - paid;
  const cash = toCents(payments.find((p) => p.method === 'cash')?.amount ?? 0);
  const pay = async () => {
    const r = await run((key) => post(`/restaurant/orders/${order.id}/pay`, {
      date: today, customer: customer || undefined, discount: toCents(discount),
      payments: payments.map((p) => ({ method: p.method, amount: toCents(p.amount) })),
    }, key), 'Paid');
    if (r) onPaid(r.id);
  };
  return (
    <Modal open onClose={onClose} title={`Pay order ${orderTitle(order)}`} width="sm"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Back</button>
        <button type="button" className="btn btn-primary" disabled={busy || credit < 0 || (credit > 0 && !customer)} onClick={pay}>{busy ? 'Saving…' : `Paid ${money(paid)}`}</button></>}>
      <div className="form-stack">
        <ul className="order-card__items">
          {order.items.map((i: any) => <li key={i.id}><span>{num(i.qty)} × {i.name}</span><span>{money(Math.round(i.qty * i.sale_price))}</span></li>)}
        </ul>
        <Field label="Discount (optional)"><MoneyInput value={discount} onChange={setDiscount} /></Field>
        <div className="cart-total"><span>To pay</span><span>{money(total)}</span></div>
        <Field label="Paid with"><PaymentsEditor value={payments} total={total} onChange={(v) => { setTouched(!(v.length === 1 && toCents(v[0].amount) === total)); setPayLines(v); }} /></Field>
        {cash > 0 && (
          <div className="form-row">
            <Field label="Cash given"><MoneyInput value={given} onChange={setGiven} /></Field>
            <Field label="Change"><div className="cart-total" style={{ fontSize: 18 }}>{money(Math.max(0, toCents(given) - cash))}</div></Field>
          </div>
        )}
        {credit > 0 && (
          <>
            <Field label="Customer who owes the rest"><PartySelect kind="customers" value={customer} onChange={setCustomer} items={customers.data ?? []} onCreated={customers.reload} placeholder="Choose…" /></Field>
            <div className={customer ? 'mc-warn' : 'mc-error'}>{money(credit)} unpaid {customer ? 'will be added to the customer’s debt.' : '— choose the customer who will owe it.'}</div>
          </>
        )}
      </div>
    </Modal>
  );
}
