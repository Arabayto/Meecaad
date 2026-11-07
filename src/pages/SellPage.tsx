import { useMemo, useState } from 'react';
import { Printer, Search, ShoppingCart, Trash2 } from 'lucide-react';
import { get, money, num, post, toCents, fromCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { SaleReceipt } from '../components/Receipt';
import { ErrorBox, Field, MoneyInput, PageHeader, PartySelect, PaymentsEditor, useLoad, useSubmit, type PayLine } from '../components/ui';

interface CartLine { product: any; qty: number }

/** Store point of sale. (The restaurant has its own order screens: RestaurantPage.) */
export function SellPage() {
  const { business, businessName, today } = useAuth();
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
    setCart([]); setDiscount(''); setCustomer(''); setGiven(''); setNote(''); setPayTouched(false); setPayLines([{ method: 'cash', amount: '' }]);
  };

  const complete = async () => {
    const r = await run((key) => post('/sales', {
      business, date: today, customer: customer || undefined, discount: toCents(discount), note,
      items: cart.map((l) => ({ product: l.product.id, qty: l.qty })),
      payments: payments.map((p) => ({ method: p.method, amount: toCents(p.amount) })),
    }, key), 'Sale saved');
    if (r) {
      setReceipt(await get(`/sales/${r.id}`));
      reset();
      products.reload(); customers.reload();
    }
  };

  return (
    <div className="module-page">
      <PageHeader icon={<ShoppingCart size={22} />} title={`Point of sale — ${businessName(business)}`} subtitle="Tap items to add them to the sale" />
      <ErrorBox error={products.error} />
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
          {!products.loading && !shown.length && <div className="mc-note">No products yet. Add them in Products &amp; Stock.</div>}
        </div>

        <div className="panel pos-cart">
          <h2 style={{ margin: 0, fontSize: 17 }}>Current sale</h2>
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
          {cart.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={reset}><Trash2 size={14} /> Clear</button>}
        </div>
      </div>

      <Modal open={Boolean(receipt)} onClose={() => setReceipt(null)} title="Sale saved" width="sm"
        footer={<>
          <button type="button" className="btn btn-secondary" onClick={() => setReceipt(null)}>New sale</button>
          <button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print receipt</button>
        </>}>
        {receipt && <SaleReceipt sale={receipt} />}
      </Modal>
    </div>
  );
}

