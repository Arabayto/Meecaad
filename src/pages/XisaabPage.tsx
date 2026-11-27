import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, BarChart2, CreditCard, DollarSign, Filter, Hash, List, Printer, ShoppingCart, Smartphone, TrendingDown, TrendingUp } from 'lucide-react';
import { get, money, num } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { fmtClock, useLoad } from '../components/ui';
import '../styles/pharma.css';

const SOURCES: [string, string][] = [['all', 'All Sources'], ['sales', 'Sales Only'], ['debts', 'Debt Payments Only'], ['expenses', 'Expenses Only'], ['suppliers', 'Suppliers & Stock'], ['other', 'Other']];
const TYPE_BADGE: Record<string, string> = { sales: 'primary', debts: 'warning', expenses: 'danger', suppliers: 'purple', other: 'secondary' };
const METHOD_BADGE: Record<string, string> = { cash: 'success', zaad: 'purple', edahab: 'orange' };
const METHOD_CARD: Record<string, [string, JSX.Element, string]> = {
  cash: ['green', <DollarSign key="c" />, 'Cash Received'], zaad: ['purple', <Smartphone key="z" />, 'Zaad Payments'], edahab: ['orange', <CreditCard key="e" />, 'E-Dahab Payments'],
};

/**
 * Xisaab Xidhka Maanta — the pharmacy's daily financial summary, for this business only:
 * money in and out per payment method, sales and debts collected, and every transaction.
 * (Counting the drawer and locking the day stay on the closing pages.)
 */
export function XisaabPage() {
  const { business, businessName, today, path, can } = useAuth();
  const navigate = useNavigate();
  const [date, setDate] = useState(today);
  const [source, setSource] = useState('all');
  const [method, setMethod] = useState('all');
  const data = useLoad(() => get('/tracking/xisaab', { business, date }), [business, date]);
  const d = data.data;
  const t = d?.totals;
  const rows = (d?.transactions ?? []).filter((x: any) => (source === 'all' || x.source === source)
    && (method === 'all' || (method === 'credit' ? x.credit > 0 : (x.methods[method] ?? 0) !== 0)));
  const methodName = (id: string) => d?.methods.find((m: any) => m.id === id)?.name ?? id;
  const debtCount = (d?.transactions ?? []).filter((x: any) => x.source === 'debts').length;
  const closing = business === 'store' ? { label: 'Count the money and close the day', to: '/closing', show: can('close') }
    : business === 'restaurant' ? { label: 'Shift closings', to: '/closings', show: can('reports') }
    : { label: 'Shifts', to: '/shifts', show: can('reports') };

  return (
    <div className="module-page ph">
      <div className="ph-head-row">
        <h2 className="ph-title"><BarChart2 size={26} /> Xisaab Xidhka Maanta</h2>
        <span className="ph-muted" style={{ fontSize: 16 }}>{businessName(business)} — {date === today ? "Today's" : date} Financial Summary</span>
      </div>

      <div className="ph-card no-print">
        <div className="ph-card__body">
          <div className="ph-xfilters">
            <div><label className="ph-label" htmlFor="x-d" style={{ color: '#212529' }}>Date</label>
              <input id="x-d" type="date" className="ph-input" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} /></div>
            <div><label className="ph-label" htmlFor="x-s" style={{ color: '#212529' }}>Source</label>
              <select id="x-s" className="ph-select" value={source} onChange={(e) => setSource(e.target.value)}>{SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><label className="ph-label" htmlFor="x-m" style={{ color: '#212529' }}>Payment Method</label>
              <select id="x-m" className="ph-select" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="all">All Methods</option>
                {(d?.methods ?? []).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
                <option value="credit">On credit</option>
              </select></div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="ph-btn ph-btn--new" style={{ flex: 1 }} onClick={() => data.reload()}><Filter size={18} /> Filter</button>
              <button type="button" className="ph-btn ph-btn--outline-secondary" onClick={() => window.print()} aria-label="Print"><Printer size={16} /></button>
            </div>
          </div>
        </div>
      </div>
      {data.error && <div className="ph-alert ph-alert--danger">{String(data.error)}</div>}
      {!t && data.loading && <div className="ph-empty">Loading…</div>}

      {t && (
        <>
          <div className="ph-cards ph-cards--4">
            <XStat tone="green" icon={<TrendingUp />} value={money(t.received)} label="Total Revenue" sub={`sales paid ${money(t.salesPaid)} · debts ${money(t.collected)}`} />
            <XStat tone="blue" icon={<ShoppingCart />} value={money(t.sales)} label={`Sales (${num(t.salesCount)})`} sub={t.salesCredit ? `${money(t.salesCredit)} on credit` : 'all paid'} />
            <XStat tone="teal" icon={<Activity />} value={money(t.collected)} label={`Debt Payments (${num(debtCount)})`} sub="debts collected" />
            <XStat tone="gray" icon={<TrendingDown />} value={money(t.paidOut)} label="Money Paid Out" sub={`expenses ${money(t.expenses)} · suppliers ${money(t.suppliers)}`} />
          </div>
          <div className="ph-cards ph-cards--4">
            {d.methods.map((m: any) => {
              const [tone, icon, title] = METHOD_CARD[m.id] ?? ['teal', <CreditCard key="x" />, `${m.name} Payments`];
              return (
                <button key={m.id} type="button" className={`ph-stat ph-stat--edge ph-stat--edge-${tone} ${method === m.id ? 'on' : ''}`} onClick={() => setMethod(method === m.id ? 'all' : m.id)}>
                  <div className="ph-stat__icon">{icon}</div>
                  <div style={{ minWidth: 0 }}><span className="ph-stat__value">{money(m.in)}</span><span className="ph-stat__label">{title}</span>
                    {m.out > 0 && <span className="ph-stat__sub">−{money(m.out)} out · net {money(m.net)}</span>}</div>
                </button>
              );
            })}
            <div className="ph-stat ph-stat--edge ph-stat--edge-teal">
              <div className="ph-stat__icon"><Hash /></div>
              <div><span className="ph-stat__value">{num(t.count)}</span><span className="ph-stat__label">Total Transactions</span>
                <span className="ph-stat__sub">net money {money(t.net)}</span></div>
            </div>
          </div>

          <div className="ph-card">
            <div className="ph-card__head">
              <h5><List /> All Transactions</h5>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {closing.show && <button type="button" className="ph-btn ph-btn--outline-secondary no-print" onClick={() => navigate(path(closing.to))}>{closing.label}</button>}
                <span className="ph-badge ph-badge--secondary">{num(rows.length)} records</span>
              </div>
            </div>
            <div className="ph-table-wrap" style={{ border: 0, borderRadius: 0 }}>
              <table className="ph-table">
                <thead><tr><th>Type</th><th>Reference</th><th>Customer</th><th>Amount</th><th>Payment</th><th>Time</th><th>By</th></tr></thead>
                <tbody>
                  {rows.map((x: any) => {
                    const methods = Object.entries(x.methods).filter(([, v]) => v !== 0);
                    return (
                      <tr key={x.id}>
                        <td><span className={`ph-badge ph-badge--${TYPE_BADGE[x.source] ?? 'secondary'}`} style={{ fontSize: 11 }}>{x.kind}</span></td>
                        <td>{x.ref && <strong>{x.ref} </strong>}<span className="xisaab-memo" title={x.memo}>{x.memo}</span></td>
                        <td>{x.party ?? (x.source === 'sales' ? 'Walk-in Customer' : <span className="ph-muted">—</span>)}</td>
                        <td><strong className={x.out > x.in ? 't-danger' : ''}>{x.in || x.out ? `${x.out > x.in ? '−' : ''}${money(Math.abs(x.in - x.out))}` : money(0)}</strong>
                          {x.credit > 0 && <div className="small ph-muted">{money(x.credit)} on credit</div>}
                          {x.owed > 0 && <div className="small ph-muted">{money(x.owed)} owed to supplier</div>}</td>
                        <td><div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {methods.map(([k]) => <span key={k} className={`ph-badge ph-badge--${METHOD_BADGE[k] ?? 'secondary'}`} style={{ fontSize: 11 }}>{methodName(k)}</span>)}
                          {!methods.length && x.credit > 0 && <span className="ph-badge ph-badge--danger">Credit</span>}
                        </div></td>
                        <td>{fmtClock(x.time)}</td>
                        <td className="small">{x.by}</td>
                      </tr>
                    );
                  })}
                  {!rows.length && <tr><td colSpan={7}><div className="ph-empty" style={{ padding: 24 }}><h5 style={{ margin: '0 0 4px' }}>No transactions found</h5>
                    <p style={{ margin: 0 }}>{d.transactions.length ? 'No transactions match the selected filters for this date.' : 'Nothing was recorded on this day.'}</p></div></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function XStat({ tone, icon, value, label, sub }: { tone: string; icon: JSX.Element; value: string; label: string; sub?: string }) {
  return (
    <div className={`ph-stat ph-stat--${tone}`}>
      <div className="ph-stat__icon">{icon}</div>
      <div style={{ minWidth: 0 }}><span className="ph-stat__value">{value}</span><span className="ph-stat__label">{label}</span>{sub && <span className="ph-stat__sub">{sub}</span>}</div>
    </div>
  );
}
