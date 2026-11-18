import { useMemo, useRef, useState } from 'react';
import { Plus, Printer, ShoppingCart, Trash2 } from 'lucide-react';
import { get, money, num, post, toCents, fromCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { SaleReceipt } from '../components/Receipt';
import { ErrorBox, Field, MoneyInput, PageHeader, PartySelect, PaymentsEditor, useLoad, useSubmit, type PayLine } from '../components/ui';
import { SalesPage } from './SalesPage';

interface CartLine { product: any; qty: number }

/**
 * Store point of sale, kept simple like a normal till: find the item (name or
 * barcode), quantity, Add; then customer, discount, payment, Complete sale.
 * Today's sales are listed underneath. (The restaurant has its own screens.)
 */
export function SellPage() {
  const { business, businessName, today } = useAuth();
  const products = useLoad(() => get('/products', { business }), [business]);
  const customers = useLoad(() => get('/customers', { business }), [business]);
  const [search, setSearch] = useState('');
  const [addQty, setAddQty] = useState('1');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState('');
  const [customer, setCustomer] = useState('');
  const [payLines, setPayLines] = useState<PayLine[]>([{ method: 'cash', amount: '' }]);
  const [payTouched, setPayTouched] = useState(false);
  const [given, setGiven] = useState('');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<any>(null);
  const [saved, setSaved] = useState(0);   // tells the history underneath to reload
  const searchRef = useRef<HTMLInputElement>(null);
  const { run, busy } = useSubmit();

  const sellable = (products.data ?? []).filter((p: any) => p.active && p.kind === 'item');
  const needle = search.trim().toLowerCase();
  // A barcode / item code typed exactly wins; otherwise names containing the text.
  const exact = needle ? sellable.find((p: any) => (p.sku ?? '').toLowerCase() === needle) : null;
  const matches = needle ? (exact ? [exact] : sellable.filter((p: any) => p.name.toLowerCase().includes(needle) || (p.category ?? '').toLowerCase().includes(needle)).slice(0, 8)) : [];

  const subtotal = useMemo(() => cart.reduce((s, l) => s + Math.round(l.qty * l.product.sale_price), 0), [cart]);
  const total = Math.max(0, subtotal - toCents(discount));
  // While one payment method covers the whole sale, its amount IS the total; typing a different amount or splitting keeps what was typed.
  const payments: PayLine[] = payTouched ? payLines : [{ method: payLines[0]?.method ?? 'cash', amount: total ? fromCents(total) : '' }];
  const paid = payments.reduce((s, p) => s + toCents(p.amount), 0);
  const credit = total - paid;

  const add = (p: any) => {
    const q = Number(addQty) > 0 ? Number(addQty) : 1;
    setCart((c) => {
      const i = c.findIndex((l) => l.product.id === p.id);
      if (i === -1) return [...c, { product: p, qty: q }];
      return c.map((l, j) => (j === i ? { ...l, qty: Math.round((l.qty + q) * 1000) / 1000 } : l));
    });
    setSearch(''); setAddQty('1');
    searchRef.current?.focus();
  };
  const setQty = (id: string, qty: number) => setCart((c) => c.map((l) => (l.product.id === id ? { ...l, qty } : l)));
  const remove = (id: string) => setCart((c) => c.filter((l) => l.product.id !== id));
  const stockProblem = cart.find((l) => l.product.track_stock && l.qty > l.product.stock_qty);
  const badQty = cart.some((l) => !(l.qty > 0));

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
      products.reload(); customers.reload(); setSaved((n) => n + 1);
    }
  };

  return (
    <div className="module-page">
      <PageHeader icon={<ShoppingCart size={22} />} title={`Point of sale — ${businessName(business)}`} subtitle="Find the item, add it, take the payment" />
      <ErrorBox error={products.error} />

      <div className="panel form-stack">
        <div className="panel__header"><div><p>New</p><h2>Sale</h2></div>{cart.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={reset}><Trash2 size={14} /> Clear</button>}</div>

        {/* 1. Find the item and add it */}
        <div className="pos-add">
          <div className="pos-add__search">
            <input ref={searchRef} className="form-input" placeholder="Item name or barcode" value={search} autoFocus aria-label="Item"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && matches.length) { e.preventDefault(); add(matches[0]); } if (e.key === 'Escape') setSearch(''); }} />
            {matches.length > 0 && (
              <ul className="pos-results">
                {matches.map((p: any) => (
                  <li key={p.id}><button type="button" onClick={() => add(p)}>
                    <span><strong>{p.name}</strong>{p.sku ? <span className="muted small"> · {p.sku}</span> : null}</span>
                    <span className="small">{money(p.sale_price)}{p.track_stock ? <span className={p.stock_qty <= 0 ? 'pos-out' : 'muted'}> · {p.stock_qty <= 0 ? 'out of stock' : `${num(p.stock_qty)} ${p.unit}`}</span> : null}</span>
                  </button></li>
                ))}
              </ul>
            )}
            {needle && !matches.length && !products.loading && <div className="pos-results pos-results--empty">No item matches “{search}”.</div>}
          </div>
          <input className="form-input pos-add__qty" inputMode="decimal" value={addQty} onChange={(e) => setAddQty(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Quantity"
            onKeyDown={(e) => { if (e.key === 'Enter' && matches.length) add(matches[0]); }} />
          <button type="button" className="btn btn-primary" disabled={!matches.length} onClick={() => add(matches[0])}><Plus size={16} /> Add</button>
        </div>
        {!products.loading && !sellable.length && <div className="mc-note">No products yet. Add them in Products &amp; Stock.</div>}

        {/* 2. What is being sold */}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th className="num">Quantity</th><th className="num">Price</th><th className="num">Total</th><th></th></tr></thead>
            <tbody>
              {cart.map((l) => (
                <tr key={l.product.id}>
                  <td><strong>{l.product.name}</strong>{l.product.track_stock ? <div className="small muted">{num(l.product.stock_qty)} {l.product.unit} in stock</div> : null}</td>
                  <td className="num"><input className="form-input" style={{ width: 90, textAlign: 'right' }} inputMode="decimal" value={l.qty || ''} aria-label={`${l.product.name} quantity`}
                    onChange={(e) => setQty(l.product.id, Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} /></td>
                  <td className="num">{money(l.product.sale_price)}</td>
                  <td className="num"><strong>{money(Math.round(l.qty * l.product.sale_price))}</strong></td>
                  <td><button type="button" className="btn btn-ghost btn-xs" onClick={() => remove(l.product.id)} aria-label={`Remove ${l.product.name}`}><Trash2 size={14} /></button></td>
                </tr>
              ))}
              {!cart.length && <tr><td colSpan={5} className="muted">No items yet. Type an item name or scan its barcode, then Add.</td></tr>}
            </tbody>
          </table>
        </div>
        {stockProblem && <div className="mc-error">Only {num(stockProblem.product.stock_qty)} {stockProblem.product.unit} of {stockProblem.product.name} in stock.</div>}

        {/* 3. Customer, discount, payment */}
        {cart.length > 0 && (
          <>
            <div className="form-row-3">
              <Field label="Customer"><PartySelect kind="customers" value={customer} onChange={setCustomer} items={customers.data ?? []} onCreated={customers.reload} /></Field>
              <Field label="Discount"><MoneyInput value={discount} onChange={setDiscount} /></Field>
              <Field label="Note (optional)"><input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            </div>
            <div className="pos-pay">
              <Field label="Payment">
                <PaymentsEditor value={payments} total={total} onChange={(v) => { setPayTouched(!(v.length === 1 && toCents(v[0].amount) === total)); setPayLines(v); }} />
              </Field>
              {payments.some((p) => p.method === 'cash') && total > 0 && (
                <div className="form-row">
                  <Field label="Cash given by customer"><MoneyInput value={given} onChange={setGiven} /></Field>
                  <Field label="Change to give back"><div className="cart-total" style={{ fontSize: 18 }}>{money(Math.max(0, toCents(given) - toCents(payments.find((p) => p.method === 'cash')?.amount ?? 0)))}</div></Field>
                </div>
              )}
            </div>
            {credit > 0 && <div className={customer ? 'mc-warn' : 'mc-error'}>{money(credit)} unpaid {customer ? 'will be added to the customer\'s debt.' : '— choose the customer who will owe it.'}</div>}
            {credit < 0 && <div className="mc-error">Payments are more than the total. Enter only the amount kept.</div>}
          </>
        )}
        <div className="pos-total">
          <div><span className="muted small">Total</span><strong>{money(total)}</strong>{toCents(discount) > 0 && <span className="small muted"> after {money(toCents(discount))} discount</span>}</div>
          <button type="button" className="btn btn-primary" style={{ minHeight: 52, minWidth: 240, fontSize: 16 }}
            disabled={busy || !cart.length || badQty || credit < 0 || (credit > 0 && !customer) || Boolean(stockProblem)} onClick={complete}>
            {busy ? 'Saving…' : `Complete sale ${money(total)}`}
          </button>
        </div>
      </div>

      {/* 4. Sales history underneath */}
      <SalesPage embedded refreshKey={saved} />

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
