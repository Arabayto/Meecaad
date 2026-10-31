import { useMemo, useState } from 'react';
import { LayoutGrid, Printer, Save, Search, ShoppingCart, Trash2, XCircle } from 'lucide-react';
import { get, money, num, patch, post, toCents, fromCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { SaleReceipt } from '../components/Receipt';
import { ErrorBox, Field, MoneyInput, PageHeader, PartySelect, PaymentsEditor, ReasonModal, useLoad, useSubmit, type PayLine } from '../components/ui';

interface CartLine { product: any; qty: number }

/** Point of sale. In the restaurant it also takes table orders that are paid later. */
export function SellPage() {
  const { business, businessName, today, can } = useAuth();
  const restaurant = business === 'restaurant';
  const tables = useLoad(() => (restaurant ? get('/restaurant/tables') : Promise.resolve([])), [restaurant]);
  const orders = useLoad(() => (restaurant ? get('/restaurant/orders') : Promise.resolve([])), [restaurant]);
  // The order being taken: a table, or a named takeaway; `orderId` when it is an existing open order.
  const [order, setOrder] = useState<{ id?: string; table?: string; label?: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const products = useLoad(() => get('/products', { business }), [business]);
  const customers = useLoad(() => get('/customers', { business }), [business]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState('');
  const [customer, setCustomer] = useState('');
  const [payLines, setPayLines] = useState<PayLine[]>([{ method: 'cash', amount: '' }]);
  const [payTouched, setPayTouched] = useState(false);
  const [given, setGiven] = useState('');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<any>(null);
  const { run, busy } = useSubmit();

  const sellable = (products.data ?? []).filter((p: any) => p.active && (p.kind === 'menu' || p.kind === 'item'));
  const categories = [...new Set(sellable.map((p: any) => p.category).filter(Boolean))] as string[];
  const shown = sellable.filter((p: any) => (!category || p.category === category) &&
    (!search || p.name.toLowerCase().includes(search.toLowerCase()) || (p.sku ?? '').toLowerCase() === search.toLowerCase()));

  const subtotal = useMemo(() => cart.reduce((s, l) => s + Math.round(l.qty * l.product.sale_price), 0), [cart]);
  const total = Math.max(0, subtotal - toCents(discount));
  // While one payment method covers the whole sale, its amount IS the total
  // (worked out in the same render, so there is never a frame where the sale
  // looks part-paid). Typing a different amount or splitting the payment
  // keeps exactly what was typed.
  const payments: PayLine[] = payTouched ? payLines : [{ method: payLines[0]?.method ?? 'cash', amount: total ? fromCents(total) : '' }];
  const paid = payments.reduce((s, p) => s + toCents(p.amount), 0);
  const credit = total - paid;

  const add = (p: any) => setCart((c) => {
    const i = c.findIndex((l) => l.product.id === p.id);
    if (i === -1) return [...c, { product: p, qty: 1 }];
    return c.map((l, j) => (j === i ? { ...l, qty: l.qty + 1 } : l));
  });
  const setQty = (id: string, qty: number) => setCart((c) => c.map((l) => (l.product.id === id ? { ...l, qty } : l)).filter((l) => l.qty > 0));

  const stockProblem = cart.find((l) => l.product.track_stock && l.qty > l.product.stock_qty);

  const reset = () => {
    setCart([]); setDiscount(''); setCustomer(''); setGiven(''); setNote(''); setPayTouched(false); setPayLines([{ method: 'cash', amount: '' }]); setOrder(null);
  };
  const items = () => cart.map((l) => ({ product: l.product.id, qty: l.qty }));

  const complete = async () => {
    const sale = {
      business, date: today, customer: customer || undefined, discount: toCents(discount), note, items: items(),
      payments: payments.map((p) => ({ method: p.method, amount: toCents(p.amount) })),
    };
    // A saved table order is paid through the order (it is closed in the same save); otherwise a direct sale.
    const r = await run((key) => (order?.id
      ? patch(`/restaurant/orders/${order.id}`, { items: items() }).then(() => post(`/restaurant/orders/${order.id}/pay`, sale, key))
      : post('/sales', sale, key)), 'Sale saved');
    if (r) {
      setReceipt(await get(`/sales/${r.id}`));
      reset();
      products.reload(); customers.reload(); orders.reload(); tables.reload();
    }
  };

  /** Restaurant: keep the order open on its table and take payment later. */
  const saveOrder = async () => {
    const r = await run((key) => (order?.id
      ? patch(`/restaurant/orders/${order.id}`, { items: items(), note })
      : post('/restaurant/orders', { table: order?.table, label: order?.label, note, items: items() }, key)), 'Order saved — pay later');
    if (r) { reset(); orders.reload(); tables.reload(); }
  };

  const openExisting = (o: any) => {
    reset();
    setOrder({ id: o.id, table: o.table_id ?? undefined, label: o.label ?? undefined });
    setNote(o.note ?? '');
    const list = products.data ?? [];
    setCart(o.items.map((i: any) => ({ product: list.find((p: any) => p.id === i.product_id) ?? { id: i.product_id, name: i.name, sale_price: i.sale_price }, qty: i.qty })));
  };
  const pickTable = (t: any) => {
    const open = (orders.data ?? []).find((o: any) => o.table_id === t.id);
    if (open) openExisting(open);
    else { reset(); setOrder({ table: t.id }); }
  };
  const orderName = order ? (order.table ? (tables.data ?? []).find((t: any) => t.id === order.table)?.name : order.label) : null;

  return (
    <div className="module-page">
      <PageHeader icon={restaurant ? <LayoutGrid size={22} /> : <ShoppingCart size={22} />} title={restaurant ? 'Orders & tables' : `Point of sale — ${businessName(business)}`}
        subtitle={restaurant ? 'Pick a table (or takeaway), add dishes, then save the order or take payment' : 'Tap items to add them to the sale'} />
      <ErrorBox error={products.error} />
      {restaurant && <TablesStrip tables={tables.data ?? []} orders={orders.data ?? []} current={order} onPick={pickTable}
        onTakeaway={(label) => { reset(); setOrder({ label }); }} onOpen={openExisting} canManage={can('catalog')} onAdded={tables.reload} />}
      <div className="pos">
        <div className="panel">
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="search-input" style={{ flex: 1, maxWidth: 'none' }}>
              <Search size={16} className="search-input__icon" />
              <input className="search-input__field form-input" style={{ paddingLeft: 36 }} placeholder="Search item or scan barcode" value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && shown.length === 1) { add(shown[0]); setSearch(''); } }} autoFocus />
            </div>
          </div>
          {categories.length > 1 && (
            <div className="scope-tabs" style={{ marginBottom: 12 }}>
              <button type="button" className={!category ? 'active' : ''} onClick={() => setCategory('')}>All</button>
              {categories.map((c) => <button key={c} type="button" className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>{c}</button>)}
            </div>
          )}
          <div className="pos-products">
            {shown.map((p: any) => (
              <button key={p.id} type="button" className="pos-product" onClick={() => add(p)} disabled={p.track_stock && p.stock_qty <= 0}>
                <strong>{p.name}</strong>
                <span className="price">{money(p.sale_price)}</span>
                {p.track_stock ? <span className="stock">{p.stock_qty <= 0 ? 'Out of stock' : `${num(p.stock_qty)} ${p.unit} in stock`}</span> : null}
              </button>
            ))}
          </div>
          {!products.loading && !shown.length && <div className="mc-note">{business === 'restaurant' ? 'No dishes or drinks yet. Add them in Menu.' : 'No products yet. Add them in Products & Stock.'}</div>}
        </div>

        <div className="panel pos-cart">
          <h2 style={{ margin: 0, fontSize: 17 }}>{orderName ? `${order?.id ? 'Order' : 'New order'} — ${orderName}` : restaurant ? 'Quick sale (pay now)' : 'Current sale'}</h2>
          {cart.length === 0 ? <p className="muted">No items yet.</p> : (
            <div>
              {cart.map((l) => (
                <div className="cart-line" key={l.product.id}>
                  <div><strong>{l.product.name}</strong><div className="muted small">{money(l.product.sale_price)} each</div></div>
                  <div className="qty-box">
                    <button type="button" onClick={() => setQty(l.product.id, Math.max(0, l.qty - 1))}>−</button>
                    <input className="form-input" inputMode="decimal" value={l.qty} onChange={(e) => setQty(l.product.id, Number(e.target.value) || 0)} />
                    <button type="button" onClick={() => setQty(l.product.id, l.qty + 1)}>+</button>
                  </div>
                  <div className="num">{money(Math.round(l.qty * l.product.sale_price))}</div>
                </div>
              ))}
            </div>
          )}
          {stockProblem && <div className="mc-error">Only {num(stockProblem.product.stock_qty)} {stockProblem.product.name} in stock.</div>}
          <Field label="Customer"><PartySelect kind="customers" value={customer} onChange={setCustomer} items={customers.data ?? []} onCreated={customers.reload} /></Field>
          <Field label="Discount"><MoneyInput value={discount} onChange={setDiscount} /></Field>
          <div className="cart-total"><span>Total</span><span>{money(total)}</span></div>
          <Field label="Payment">
            <PaymentsEditor value={payments} total={total} onChange={(v) => { setPayTouched(!(v.length === 1 && toCents(v[0].amount) === total)); setPayLines(v); }} />
          </Field>
          {credit > 0 && (
            <div className={customer ? 'mc-warn' : 'mc-error'}>
              {money(credit)} unpaid {customer ? 'will be added to the customer\'s debt.' : '— choose the customer who will owe it.'}
            </div>
          )}
          {credit < 0 && <div className="mc-error">Payments are more than the total. Enter only the amount kept.</div>}
          {payments.some((p) => p.method === 'cash') && total > 0 && (
            <div className="form-row">
              <Field label="Cash given by customer"><MoneyInput value={given} onChange={setGiven} /></Field>
              <Field label="Change to give back"><div className="cart-total" style={{ fontSize: 18 }}>{money(Math.max(0, toCents(given) - toCents(payments.find((p) => p.method === 'cash')?.amount ?? 0)))}</div></Field>
            </div>
          )}
          <Field label="Note (optional)"><input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <button type="button" className="btn btn-primary btn-block" disabled={busy || !cart.length || credit < 0 || (credit > 0 && !customer) || Boolean(stockProblem)} onClick={complete}>
            {busy ? 'Saving…' : `Complete sale ${money(total)}`}
          </button>
          {restaurant && order && (
            <button type="button" className="btn btn-secondary btn-block" disabled={busy || !cart.length} onClick={saveOrder}>
              <Save size={16} /> {order.id ? 'Update order (pay later)' : 'Save order (pay later)'}
            </button>
          )}
          <div className="row" style={{ justifyContent: 'space-between' }}>
            {(cart.length > 0 || order) && <button type="button" className="btn btn-ghost btn-sm" onClick={reset}><Trash2 size={14} /> {order ? 'Close without saving' : 'Clear'}</button>}
            {order?.id && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCancelling(true)}><XCircle size={14} /> Cancel order</button>}
          </div>
        </div>
      </div>

      <Modal open={Boolean(receipt)} onClose={() => setReceipt(null)} title="Sale saved" width="sm"
        footer={<>
          <button type="button" className="btn btn-secondary" onClick={() => setReceipt(null)}>New sale</button>
          <button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print receipt</button>
        </>}>
        {receipt && <SaleReceipt sale={receipt} />}
      </Modal>
      {order?.id && <ReasonModal open={cancelling} onClose={() => setCancelling(false)} title={`Cancel the order for ${orderName}?`} action={`/restaurant/orders/${order.id}/cancel`}
        confirmLabel="Cancel order" message="Nothing was paid yet, so no money or stock changes. The cancellation is recorded."
        onDone={() => { reset(); orders.reload(); tables.reload(); }} />}
    </div>
  );
}

/** Restaurant tables (free / with an open order) plus takeaway orders. */
function TablesStrip({ tables, orders, current, onPick, onTakeaway, onOpen, canManage, onAdded }: {
  tables: any[]; orders: any[]; current: { id?: string; table?: string } | null; onPick: (t: any) => void; onTakeaway: (label: string) => void;
  onOpen: (o: any) => void; canManage: boolean; onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const { run, busy } = useSubmit();
  const takeaways = orders.filter((o) => !o.table_id);
  const addTable = async () => {
    const r = await run((key) => post('/restaurant/tables', { name }, key), 'Table added');
    if (r) { setName(''); setAdding(false); onAdded(); }
  };
  return (
    <div className="panel">
      <div className="tables-grid">
        {tables.filter((t) => t.active).map((t) => {
          const o = orders.find((x) => x.table_id === t.id);
          return (
            <button key={t.id} type="button" className={`table-tile ${o ? 'table-tile--busy' : ''} ${current?.table === t.id ? 'table-tile--current' : ''}`} onClick={() => onPick(t)}>
              <strong>{t.name}</strong>
              <span>{o ? `${money(o.total)} · since ${new Date(o.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'Free'}</span>
            </button>
          );
        })}
        {takeaways.map((o) => (
          <button key={o.id} type="button" className={`table-tile table-tile--busy ${current?.id === o.id ? 'table-tile--current' : ''}`} onClick={() => onOpen(o)}>
            <strong>{o.label}</strong><span>{money(o.total)} · takeaway</span>
          </button>
        ))}
        <button type="button" className="table-tile table-tile--add" onClick={() => { const label = window.prompt('Name for this takeaway order (e.g. customer name)', 'Takeaway'); if (label) onTakeaway(label); }}>
          <strong>+ Takeaway</strong><span>order to pay later</span>
        </button>
        {canManage && (adding ? (
          <div className="table-tile table-tile--add">
            <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Table name" autoFocus />
            <div className="row"><button type="button" className="btn btn-primary btn-xs" disabled={busy || !name.trim()} onClick={addTable}>Add</button>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setAdding(false)}>✕</button></div>
          </div>
        ) : <button type="button" className="table-tile table-tile--add" onClick={() => setAdding(true)}><strong>+ Table</strong><span>add a table</span></button>)}
      </div>
      {!tables.length && <p className="small muted" style={{ marginTop: 8 }}>No tables yet.{canManage ? ' Add your tables with “+ Table”.' : ''} Quick sales can be paid right away below without a table.</p>}
    </div>
  );
}
