import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Calendar, Check, CreditCard, DollarSign, Eye, Filter, Package, Plus, PlusCircle, Printer, RotateCcw, Search, ShoppingCart, Trash2, X,
} from 'lucide-react';
import { get, money, num, post } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Modal } from '../components/Modal';
import { SaleReceipt } from '../components/Receipt';
import { ReasonModal, useLoad, useSubmit } from '../components/ui';
import { ReturnModal } from './SalesPage';
import '../styles/pharma.css';

const TZ = 'Africa/Mogadishu';
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: TZ, month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const ROLE: Record<string, string> = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier', staff: 'Staff' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Store sales — the same page as the pharmacy's: four figures, filters & search, the sales
 * records (view items, receipt, return, cancel) and a "New Sale" window to sell.
 */
export function StoreSalesPage() {
  const { business, can, activeMethods } = useAuth();
  const [filters, setFilters] = useState({ q: '', method: '', debt: '', from: '', to: '' });
  const [q, setQ] = useState('');   // search, applied a moment after typing stops
  useEffect(() => { const t = setTimeout(() => setQ(filters.q.trim()), 300); return () => clearTimeout(t); }, [filters.q]);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [q, filters.method, filters.debt, filters.from, filters.to]);
  const [saved, setSaved] = useState(0);
  const stats = useLoad(() => get('/sales/stats', { business }), [business, saved]);
  const list = useLoad(() => get('/sales/records', { business, page: String(page), q, method: filters.method, debt: filters.debt, from: filters.from, to: filters.to }),
    [business, page, q, filters.method, filters.debt, filters.from, filters.to, saved]);
  const [newSale, setNewSale] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<any>(null);
  const [returning, setReturning] = useState<any>(null);
  const [cancelling, setCancelling] = useState<any>(null);
  const active = Boolean(filters.q || filters.method || filters.debt || filters.from || filters.to);
  const set = (k: keyof typeof filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const s = stats.data;
  const d = list.data;
  const rows = d?.rows ?? [];
  const refresh = () => setSaved((n) => n + 1);
  const openFull = async (id: string) => get(`/sales/${id}`);

  return (
    <div className="module-page ph">
      <div className="ph-topbar">
        {can('sell') && <button type="button" className="ph-btn ph-btn--new" onClick={() => setNewSale(true)}><Plus size={18} /> New Sale</button>}
      </div>

      <div className="ph-cards">
        <Stat tone="blue" icon={<ShoppingCart />} value={s ? num(s.total) : '—'} label="Total Sales" />
        <Stat tone="indigo" icon={<Calendar />} value={s ? num(s.today) : '—'} label="Today's Sales" />
        <Stat tone="green" icon={<DollarSign />} value={s ? money(s.todayRevenue) : '—'} label="Today's Revenue" />
        <Stat tone="purple" icon={<Package />} value={s ? num(s.products) : '—'} label="Available Products" />
      </div>

      <div className="ph-card">
        <div className="ph-card__head">
          <h6><Filter /> Filters &amp; Search</h6>
          {active && <button type="button" className="ph-btn ph-btn--outline-secondary" onClick={() => setFilters({ q: '', method: '', debt: '', from: '', to: '' })}><X size={14} /> Clear</button>}
        </div>
        <div className="ph-card__body">
          <div className="ph-filters">
            <div>
              <label className="ph-label" htmlFor="ph-q"><Search /> Search</label>
              <input id="ph-q" className="ph-input" placeholder="Sale number, customer name, phone, item…" value={filters.q} onChange={(e) => set('q', e.target.value)} />
            </div>
            <div>
              <label className="ph-label" htmlFor="ph-m"><CreditCard /> Payment Method</label>
              <select id="ph-m" className="ph-select" value={filters.method} onChange={(e) => set('method', e.target.value)}>
                <option value="">All Payment Methods</option>
                {activeMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div>
              <label className="ph-label" htmlFor="ph-d"><AlertCircle /> Debt Status</label>
              <select id="ph-d" className="ph-select" value={filters.debt} onChange={(e) => set('debt', e.target.value)}>
                <option value="">All</option><option value="paid">Paid</option><option value="debt">Debt</option><option value="cancelled">Cancelled</option>
              </select>
            </div>
            <div>
              <label className="ph-label" htmlFor="ph-f"><Calendar /> From Date</label>
              <input id="ph-f" type="date" className="ph-input" value={filters.from} max={filters.to || undefined} onChange={(e) => set('from', e.target.value)} />
            </div>
            <div>
              <label className="ph-label" htmlFor="ph-t"><Calendar /> To Date</label>
              <input id="ph-t" type="date" className="ph-input" value={filters.to} min={filters.from || undefined} onChange={(e) => set('to', e.target.value)} />
            </div>
          </div>
        </div>
      </div>

      <div className="ph-card">
        <div className="ph-card__head">
          <h5><ShoppingCart /> Sales Records</h5>
          <span className="ph-badge ph-badge--primary">{d ? `${num(d.total)}${d.more ? '+' : ''} sales` : '…'}</span>
        </div>
        <div className="ph-card__body">
          {list.error && <div className="ph-alert ph-alert--danger">{String(list.error)}</div>}
          {!d && list.loading && <div className="ph-empty">Loading…</div>}
          {d && !rows.length && (
            <div className="ph-empty"><ShoppingCart /><h5 style={{ margin: '12px 0 4px' }}>No sales found</h5><p style={{ margin: 0 }}>{active ? 'Try different filters.' : 'Sales appear here. Press New Sale to make one.'}</p></div>
          )}
          {rows.length > 0 && (
            <div className="ph-table-wrap">
              <table className="ph-table ph-table--striped">
                <thead><tr><th>Sale #</th><th>Customer</th><th>Items Sold</th><th>Sold By</th><th>Date</th><th>Total</th><th>Payment</th><th>Actions</th></tr></thead>
                <tbody>
                  {rows.map((r: any, i: number) => {
                    const cancelled = r.status === 'voided';
                    const open = expanded === r.id;
                    return (
                      <SaleRows key={r.id} r={r} shade={i % 2 === 0} open={open}>
                        <td><strong>#{r.number}</strong></td>
                        <td>{r.customer_name ?? 'Walk-in Customer'}{r.customer_phone && <><br /><small className="ph-muted">{r.customer_phone}</small></>}</td>
                        <td><div className="ph-items">{r.items.map((it: any) => (
                          <div key={it.id} className="item"><strong>{it.name}</strong><span className="x"> × {num(it.qty)}</span>
                            {it.returned_qty > 0 && <small className="t-danger"> ({num(it.returned_qty)} returned)</small>}</div>
                        ))}</div></td>
                        <td><div className="ph-seller"><strong>{r.created_by_name}</strong><br /><small>{ROLE[r.created_by_role] ?? 'Staff'}</small></div></td>
                        <td>{when(r.created_at)}</td>
                        <td><strong>{money(r.total)}</strong>{r.returned_amount > 0 && <div className="small ph-muted">−{money(r.returned_amount)} returned</div>}</td>
                        <td>
                          {cancelled ? <span className="ph-badge ph-badge--secondary">Cancelled</span> : (
                            <div style={{ display: 'grid', gap: 4, justifyItems: 'start' }}>
                              {r.methods.map((m: string) => <span key={m} className="ph-badge ph-badge--method">{cap(m)}</span>)}
                              {r.credit_amount > 0 && <><span className="ph-badge ph-badge--danger">DEBT</span><small className="t-danger">Owes {money(r.credit_amount)}</small></>}
                            </div>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button type="button" className="ph-icon-btn ph-icon-btn--primary" title="Receipt" aria-label={`Receipt of sale ${r.number}`} onClick={async () => setReceipt(await openFull(r.id))}><Printer /></button>
                          <button type="button" className={`ph-icon-btn ph-icon-btn--info ${open ? 'on' : ''}`} title="View Items" aria-label={`Items of sale ${r.number}`} onClick={() => setExpanded(open ? null : r.id)}><Eye /></button>
                          {can('void') && <button type="button" className="ph-icon-btn ph-icon-btn--warning" title="Return items" aria-label={`Return items of sale ${r.number}`} disabled={cancelled || r.returned_amount >= r.total}
                            onClick={async () => setReturning(await openFull(r.id))}><RotateCcw /></button>}
                          {can('void') && <button type="button" className="ph-icon-btn ph-icon-btn--danger" title="Cancel sale" aria-label={`Cancel sale ${r.number}`} disabled={cancelled || r.returned_amount > 0}
                            onClick={() => setCancelling(r)}><Trash2 /></button>}
                        </td>
                      </SaleRows>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {d && d.pages > 1 && <Pages page={page} pages={d.pages} more={d.more} onPage={setPage} />}
        </div>
      </div>

      {newSale && <NewSaleModal onClose={() => setNewSale(false)} rate={s?.rate ?? null}
        onSaved={async (id) => { setNewSale(false); refresh(); setReceipt(await openFull(id)); }} />}
      <Modal open={Boolean(receipt)} onClose={() => setReceipt(null)} title={receipt ? `Sale #${receipt.number}` : ''} width="sm"
        footer={<><button type="button" className="btn btn-secondary" onClick={() => setReceipt(null)}>Close</button>
          <button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print receipt</button></>}>
        {receipt && <SaleReceipt sale={receipt} />}
      </Modal>
      {returning && <ReturnModal sale={returning} onClose={() => setReturning(null)} onDone={() => { setReturning(null); refresh(); }} />}
      {cancelling && <ReasonModal open onClose={() => setCancelling(null)} title={`Cancel sale #${cancelling.number}?`} action={`/sales/${cancelling.id}/void`} confirmLabel="Cancel sale"
        message={<>The money ({money(cancelling.total)}) is reversed{cancelling.credit_amount ? ' and the customer debt removed' : ''}, and stock goes back. The sale stays in the records marked as cancelled.</>}
        onDone={refresh} />}
    </div>
  );
}

function Stat({ tone, icon, value, label }: { tone: string; icon: JSX.Element; value: string; label: string }) {
  return (
    <div className={`ph-stat ph-stat--${tone}`}>
      <div className="ph-stat__icon">{icon}</div>
      <div style={{ minWidth: 0 }}><span className="ph-stat__value">{value}</span><span className="ph-stat__label">{label}</span></div>
    </div>
  );
}

/** A sale row, and under it (when opened) the list of its items. */
function SaleRows({ r, shade, open, children }: { r: any; shade: boolean; open: boolean; children: React.ReactNode }) {
  return (
    <>
      <tr className={`ph-row ${shade ? 'ph-row--shade' : ''}`}>{children}</tr>
      {open && (
        <tr className="ph-detail"><td colSpan={8}>
          <div className="ph-detail__box">
            <h6>Sale Items:</h6>
            <div className="ph-table-wrap">
              <table className="ph-table ph-table--sm">
                <thead><tr><th>Product</th><th>Quantity</th><th>Unit Price</th><th>Total</th></tr></thead>
                <tbody>
                  {r.items.map((it: any) => (
                    <tr key={it.id}><td>{it.name}</td><td>{num(it.qty)}{it.returned_qty > 0 && <small className="t-danger"> ({num(it.returned_qty)} returned)</small>}</td><td>{money(it.unit_price)}</td><td>{money(it.line_total)}</td></tr>
                  ))}
                  {r.discount > 0 && <tr><td colSpan={3} style={{ textAlign: 'right' }}>Discount</td><td>−{money(r.discount)}</td></tr>}
                </tbody>
              </table>
            </div>
            {r.payments_text && <p className="small ph-muted" style={{ margin: '8px 0 0' }}>Paid: {r.payments_text}{r.note ? ` · ${r.note}` : ''}</p>}
          </div>
        </td></tr>
      )}
    </>
  );
}

function Pages({ page, pages, more, onPage }: { page: number; pages: number; more: boolean; onPage: (p: number) => void }) {
  const list: (number | '…')[] = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - page) <= 2) list.push(p);
    else if (list[list.length - 1] !== '…') list.push('…');
  }
  return (
    <nav aria-label="Sales pages">
      <div className="ph-pages">
        <button type="button" disabled={page === 1} onClick={() => onPage(page - 1)}>‹</button>
        {list.map((p, i) => (p === '…' ? <button key={`e${i}`} type="button" disabled>…</button>
          : <button key={p} type="button" className={p === page ? 'on' : ''} onClick={() => onPage(p)}>{p}</button>))}
        <button type="button" disabled={page === pages} onClick={() => onPage(page + 1)}>›</button>
      </div>
      <div className="ph-pages-note">Page {page} of {pages}{more ? ' — use the dates to see older sales' : ''}</div>
    </nav>
  );
}

// ── New Sale window ────────────────────────────────────────────
interface Line { product: any; qty: number }

/** "rice 2" → { term: "rice", qty: 2 }; "rice" → qty 1. */
const parseQuick = (text: string) => {
  const m = text.trim().match(/^(.*?)(?:\s+(\d+(?:\.\d+)?))?$/);
  const term = (m?.[1] ?? '').trim();
  const qty = m?.[2] ? Number(m[2]) : 1;
  return { term, qty: qty > 0 ? qty : 1 };
};

function NewSaleModal({ onClose, onSaved, rate }: { onClose: () => void; onSaved: (id: string) => void; rate: number | null }) {
  const { business, today, activeMethods } = useAuth();
  const { addToast } = useToast();
  const products = useLoad(() => get('/products', { business }), [business]);
  const customers = useLoad(() => get('/customers', { business }), [business]);
  const [custText, setCustText] = useState('');
  const [customer, setCustomer] = useState<any>(null);
  const [custOpen, setCustOpen] = useState(false);
  const [quick, setQuick] = useState('');
  const [hi, setHi] = useState(0);
  const [cart, setCart] = useState<Line[]>([]);
  const [method, setMethod] = useState(activeMethods[0]?.id ?? 'cash');
  const [debt, setDebt] = useState(false);
  const quickRef = useRef<HTMLInputElement>(null);
  const { run, busy } = useSubmit();
  const { run: runCust, busy: addingCust } = useSubmit();

  const sellable = (products.data ?? []).filter((p: any) => p.active && p.kind === 'item');
  const { term, qty } = parseQuick(quick);
  const needle = term.toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return [];
    const exact = sellable.filter((p: any) => (p.sku ?? '').toLowerCase() === needle);
    if (exact.length) return exact;
    const starts = sellable.filter((p: any) => p.name.toLowerCase().startsWith(needle));
    const has = sellable.filter((p: any) => !p.name.toLowerCase().startsWith(needle) && `${p.name} ${p.category ?? ''}`.toLowerCase().includes(needle));
    return [...starts, ...has].slice(0, 8);
  }, [needle, sellable]);
  useEffect(() => setHi(0), [needle]);
  const custMatches = custText.trim() && custOpen
    ? (customers.data ?? []).filter((c: any) => c.active !== 0 && `${c.name} ${c.phone ?? ''}`.toLowerCase().includes(custText.trim().toLowerCase())).slice(0, 8) : [];

  const total = cart.reduce((s, l) => s + Math.round(l.qty * l.product.sale_price), 0);
  const slsh = rate ? Math.round((total / 100) * rate) : null;
  const short = cart.find((l) => l.product.track_stock && l.qty > l.product.stock_qty);
  const badQty = cart.some((l) => !(l.qty > 0));
  const needCustomer = debt && !customer;

  const add = (p: any) => {
    setCart((c) => {
      const i = c.findIndex((l) => l.product.id === p.id);
      if (i === -1) return [...c, { product: p, qty }];
      return c.map((l, j) => (j === i ? { ...l, qty: Math.round((l.qty + qty) * 1000) / 1000 } : l));
    });
    setQuick(''); quickRef.current?.focus();
  };
  const complete = async () => {
    if (!cart.length || busy || badQty || short || needCustomer) {
      if (needCustomer) addToast('error', 'Choose the customer who owes this sale (Customer, at the top).', 4000);
      return;
    }
    const r = await run((key) => post('/sales', {
      business, date: today, customer: customer?.id,
      items: cart.map((l) => ({ product: l.product.id, qty: l.qty })),
      payments: debt ? [] : [{ method, amount: total }],
    }, key), 'Sale completed');
    if (r) onSaved(r.id);
  };
  const addCustomer = async () => {
    const name = custText.trim();
    const r = await runCust((key) => post('/customers', { business, name }, key), `${name} added`);
    if (r) { setCustomer({ id: r.id, name }); setCustOpen(false); customers.reload(); }
  };

  // Keyboard: Ctrl+Enter or F9 completes; Ctrl+Delete removes the last item.
  const completeRef = useRef(complete); completeRef.current = complete;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey && e.key === 'Enter') || e.key === 'F9') { e.preventDefault(); completeRef.current(); }
      if (e.ctrlKey && e.key === 'Delete') { e.preventDefault(); setCart((c) => c.slice(0, -1)); }
      if (e.key === 'Escape' && document.activeElement !== quickRef.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { quickRef.current?.focus(); }, []);

  return (
    <div className="ph-modal-backdrop" role="dialog" aria-modal="true" aria-label="New Sale" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ph-modal ph">
        <div className="ph-modal__head">
          <h5><Plus /> New Sale</h5>
          <button type="button" className="ph-close" onClick={onClose} aria-label="Close"><X size={22} /></button>
        </div>
        <div className="ph-modal__body">
          <div>
            <label className="ph-label" htmlFor="ph-cust" style={{ color: '#212529' }}>Customer <small>(Optional - defaults to Walk-in)</small></label>
            <div style={{ position: 'relative' }}>
              <input id="ph-cust" className="ph-input" placeholder="Search customer..." value={customer ? customer.name : custText} autoComplete="off"
                onChange={(e) => { setCustomer(null); setCustText(e.target.value); setCustOpen(true); }} onFocus={() => setCustOpen(true)} onBlur={() => setTimeout(() => setCustOpen(false), 150)} />
              {custOpen && !customer && custText.trim() && (
                <div className="ph-suggest">
                  {custMatches.map((c: any) => (
                    <button key={c.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setCustomer(c); setCustOpen(false); }}>
                      {c.name} {c.phone && <small className="ph-muted">- {c.phone}</small>}{c.balance > 0 && <small className="t-danger"> · owes {money(c.balance)}</small>}
                    </button>
                  ))}
                  <button type="button" disabled={addingCust} onMouseDown={(e) => e.preventDefault()} onClick={addCustomer}><Plus size={14} /> Add “{custText.trim()}” as a new customer</button>
                </div>
              )}
            </div>
            {customer && <small className="ph-muted">Selected: {customer.name} <button type="button" className="ph-remove" onClick={() => { setCustomer(null); setCustText(''); }} aria-label="Remove customer">✕</button></small>}
          </div>

          <div className="ph-card">
            <div className="ph-card__head"><h6><PlusCircle /> Add Product</h6></div>
            <div className="ph-card__body">
              <div className="ph-group">
                <span className="ph-group-text"><Search size={16} /></span>
                <input ref={quickRef} className="ph-input ph-input--lg" placeholder='Type product, qty (e.g., "rice 2")' autoComplete="off" value={quick} aria-label="Product"
                  onChange={(e) => setQuick(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
                    if (e.key === 'Enter' && !e.ctrlKey && matches[hi]) { e.preventDefault(); add(matches[hi]); }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setQuick(''); }
                  }} />
                <button type="button" className="ph-btn ph-btn--success" disabled={!matches[hi]} onClick={() => matches[hi] && add(matches[hi])}>Add</button>
              </div>
              {matches.length > 0 && (
                <div className="ph-suggest ph-suggest--inline">
                  {matches.map((p: any, i: number) => (
                    <button key={p.id} type="button" className={i === hi ? 'on' : ''} onMouseEnter={() => setHi(i)} onClick={() => add(p)}>
                      <strong>{p.name}</strong> - {num(qty)} {p.unit} @ {money(p.sale_price)} = {money(Math.round(qty * p.sale_price))}
                      {p.track_stock ? <span className={p.stock_qty <= 0 ? 'out' : 'ph-muted'} style={{ fontSize: 13 }}> · {p.stock_qty <= 0 ? 'out of stock' : `${num(p.stock_qty)} in stock`}</span> : null}
                    </button>
                  ))}
                </div>
              )}
              {needle && !matches.length && !products.loading && <div className="ph-hint">No product matches “{term}”.</div>}
              <div className="ph-hint"><kbd>Enter</kbd> Add to cart<span className="sep">|</span><kbd>↑</kbd><kbd>↓</kbd> Navigate<span className="sep">|</span><kbd>Esc</kbd> Clear</div>
            </div>
          </div>

          {cart.length > 0 && (
            <div className="ph-card">
              <div className="ph-card__head"><h6>Sale Items</h6><span className="ph-badge ph-badge--primary">{cart.length} item{cart.length !== 1 ? 's' : ''}</span></div>
              <div className="ph-card__body">
                <div className="ph-table-wrap">
                  <table className="ph-table">
                    <thead><tr><th>Product</th><th>Unit Type</th><th>Quantity</th><th>Unit Price</th><th>Subtotal</th><th></th></tr></thead>
                    <tbody>
                      {cart.map((l, idx) => (
                        <tr key={l.product.id}>
                          <td>{l.product.name}{l.product.track_stock ? <div className="small ph-muted">{num(l.product.stock_qty)} in stock</div> : null}</td>
                          <td><span className="ph-badge ph-badge--unit">{l.product.unit}</span></td>
                          <td><input className="ph-qty" inputMode="decimal" value={l.qty || ''} aria-label={`${l.product.name} quantity`}
                            onChange={(e) => { const v = Number(e.target.value.replace(/[^0-9.]/g, '')) || 0; setCart((c) => c.map((x, j) => (j === idx ? { ...x, qty: v } : x))); }} /></td>
                          <td>{money(l.product.sale_price)}</td>
                          <td><strong>{money(Math.round(l.qty * l.product.sale_price))}</strong></td>
                          <td><button type="button" className="ph-remove" onClick={() => setCart((c) => c.filter((_, j) => j !== idx))} title="Remove" aria-label={`Remove ${l.product.name}`}>✕</button></td>
                        </tr>
                      ))}
                      <tr className="ph-total-row"><th colSpan={4} style={{ textAlign: 'right' }}>Total:</th><th colSpan={2}>{money(total)}</th></tr>
                      {slsh !== null && <tr className="ph-slsh-row"><th colSpan={4} style={{ textAlign: 'right' }}>SLSH Equivalent:</th><th colSpan={2}>{slsh.toLocaleString('en-US')} SLSH</th></tr>}
                    </tbody>
                  </table>
                </div>
                <div className="ph-hint" style={{ justifyContent: 'center' }}><kbd>Ctrl</kbd>+<kbd>Delete</kbd> to remove last item</div>
                {short && <div className="ph-alert ph-alert--danger" style={{ marginTop: 10 }}>Only {num(short.product.stock_qty)} {short.product.unit} of {short.product.name} in stock.</div>}
              </div>
            </div>
          )}

          <div className="ph-row-2">
            <div>
              <label className="ph-label" htmlFor="ph-pay" style={{ color: '#212529' }}>Payment Method</label>
              <select id="ph-pay" className="ph-select" value={method} disabled={debt} onChange={(e) => setMethod(e.target.value)}>
                {activeMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div>
              <label className="ph-label" style={{ color: '#212529' }}>Expected SLSH (Auto-calculated)</label>
              <div className="ph-group">
                <span className="ph-group-text">SLSH</span>
                <input className="ph-input" readOnly value={slsh === null ? '—' : slsh.toLocaleString('en-US')} aria-label="Expected SLSH" />
                <span className="ph-group-text"><small className="ph-muted">{rate ? `@ ${rate.toLocaleString('en-US')} rate` : 'no rate set'}</small></span>
              </div>
              <small className="ph-muted">System automatically calculates from admin's daily rate</small>
            </div>
          </div>
          <label className="ph-check"><input type="checkbox" checked={debt} onChange={(e) => setDebt(e.target.checked)} /><AlertCircle /> Customer did not pay (Mark as DEBT)</label>
          {needCustomer && <div className="ph-alert ph-alert--warning">Choose the customer who owes it in <strong>Customer</strong> above (or add a new one).</div>}
        </div>
        <div className="ph-modal__foot">
          <div className="ph-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> or <kbd>F9</kbd> to complete sale</div>
          <button type="button" className="ph-btn ph-btn--secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="ph-btn ph-btn--primary" disabled={busy || !cart.length || badQty || Boolean(short) || needCustomer} onClick={complete}>
            <Check size={18} /> {busy ? 'Saving…' : 'Complete Sale (Ctrl+Enter)'}
          </button>
        </div>
      </div>
    </div>
  );
}
