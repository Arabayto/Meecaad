import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ClipboardCheck, Printer } from 'lucide-react';
import { get, money, num } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { ErrorBox, PageHeader, Stat, addDays, fmtClock, useLoad } from '../components/ui';
import { StatusBadge } from '../components/StatusBadge';

const SOURCES: [string, string][] = [['all', 'Everything'], ['sales', 'Sales'], ['debts', 'Debt payments'], ['expenses', 'Expenses'], ['suppliers', 'Suppliers & stock'], ['other', 'Other']];
const TONE: Record<string, 'green' | 'yellow' | 'red' | 'blue' | 'neutral'> = { sales: 'green', debts: 'yellow', expenses: 'red', suppliers: 'blue', other: 'neutral' };

/**
 * Xisaab Xidhka Maanta — the day's money for this business only: what came in and went out in
 * each payment method, sales paid now or on credit, debts collected, and every transaction.
 * (Counting the drawer and locking the day is done on the closing page.)
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
  const closing = business === 'store' ? { label: 'Count the money and close the day', to: '/closing', show: can('close') }
    : business === 'restaurant' ? { label: 'Shift closings', to: '/closings', show: can('reports') }
    : { label: 'Shifts', to: '/shifts', show: can('reports') };

  return (
    <div className="module-page">
      <PageHeader icon={<ClipboardCheck size={22} />} title="Xisaab Xidhka Maanta" subtitle={`The day's money — ${businessName(business)} only`}
        actions={<button type="button" className="btn btn-secondary no-print" onClick={() => window.print()}><Printer size={16} /> Print</button>} />

      <div className="panel no-print">
        <div className="xisaab-filters">
          <div className="xisaab-day">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDate(addDays(date, -1))} aria-label="Day before"><ChevronLeft size={16} /></button>
            <input type="date" className="form-input date-input" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Day" />
            <button type="button" className="btn btn-ghost btn-sm" disabled={date >= today} onClick={() => setDate(addDays(date, 1))} aria-label="Next day"><ChevronRight size={16} /></button>
            {date !== today && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDate(today)}>Today</button>}
          </div>
          <select className="form-select" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
            {SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="form-select" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Payment method">
            <option value="all">All payment methods</option>
            {(d?.methods ?? []).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
            <option value="credit">On credit</option>
          </select>
        </div>
      </div>
      <ErrorBox error={data.error} />

      {t && (
        <>
          <div className="kpi-grid">
            <Stat label="Money received" value={money(t.received)} sub={`sales paid ${money(t.salesPaid)} · debts collected ${money(t.collected)}`} />
            <Stat label="Sales" value={money(t.sales)} sub={`${num(t.salesCount)} sale${t.salesCount === 1 ? '' : 's'} · ${money(t.salesCredit)} on credit`} />
            <Stat label="Money paid out" value={money(t.paidOut)} sub={`expenses ${money(t.expenses)} · suppliers ${money(t.suppliers)}`} />
            <Stat label="Net money of the day" value={money(t.net)} tone={t.net < 0 ? 'red' : t.net > 0 ? 'green' : undefined} sub={`${num(t.count)} transaction${t.count === 1 ? '' : 's'}`} />
          </div>

          <div className="xisaab-methods">
            {d.methods.map((m: any) => (
              <div key={m.id} className={`xisaab-method ${method === m.id ? 'active' : ''}`} role="button" tabIndex={0}
                onClick={() => setMethod(method === m.id ? 'all' : m.id)} onKeyDown={(e) => { if (e.key === 'Enter') setMethod(method === m.id ? 'all' : m.id); }}>
                <span className="xisaab-method__name">{m.name}</span>
                <strong>{money(m.net)}</strong>
                <span className="small"><span style={{ color: '#15803d' }}>+{money(m.in)} in</span>{m.out > 0 && <> · <span style={{ color: '#b91c1c' }}>−{money(m.out)} out</span></>}</span>
              </div>
            ))}
            <div className={`xisaab-method ${method === 'credit' ? 'active' : ''}`} role="button" tabIndex={0}
              onClick={() => setMethod(method === 'credit' ? 'all' : 'credit')} onKeyDown={(e) => { if (e.key === 'Enter') setMethod(method === 'credit' ? 'all' : 'credit'); }}>
              <span className="xisaab-method__name">On credit</span>
              <strong>{money(t.salesCredit)}</strong>
              <span className="small muted">given today (not money yet)</span>
            </div>
          </div>

          <div className="panel">
            <div className="panel__header xisaab-head">
              <div><p>{rows.length === d.transactions.length ? `${num(rows.length)} transactions` : `${num(rows.length)} of ${num(d.transactions.length)} transactions`}</p><h2>All transactions</h2></div>
              {closing.show && <button type="button" className="btn btn-secondary btn-sm no-print" onClick={() => navigate(path(closing.to))}>{closing.label}</button>}
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Time</th><th>Type</th><th>What</th><th>Customer / supplier</th><th className="num">In</th><th className="num">Out</th><th>Paid with</th></tr></thead>
                <tbody>
                  {rows.map((x: any) => (
                    <tr key={x.id}>
                      <td className="small">{fmtClock(x.time)}<div className="muted">{x.by}</div></td>
                      <td><StatusBadge label={x.kind} tone={TONE[x.source] ?? 'neutral'} /></td>
                      <td className="small"><div className="xisaab-memo" title={x.memo}>{x.ref && <strong>{x.ref} </strong>}{x.memo}</div></td>
                      <td className="small">{x.party ?? <span className="muted">{x.source === 'sales' ? 'Walk-in' : '—'}</span>}</td>
                      <td className="num">{x.in ? <span style={{ color: '#15803d' }}>{money(x.in)}</span> : x.credit ? <span className="muted">{money(x.credit)} credit</span> : '—'}</td>
                      <td className="num">{x.out ? <span style={{ color: '#b91c1c' }}>{money(x.out)}</span> : x.owed > 0 ? <span className="muted">{money(x.owed)} owed</span> : '—'}</td>
                      <td className="small">{Object.entries(x.methods).map(([k, v]) => `${methodName(k)} ${money(Math.abs(v as number))}`).join(', ') || (x.credit ? 'On credit' : x.owed > 0 ? 'Owed to supplier' : '—')}</td>
                    </tr>
                  ))}
                  {!rows.length && <tr><td colSpan={7} className="muted">{d.transactions.length ? 'No transaction matches these filters.' : 'No transactions on this day.'}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {!t && data.loading && <div className="panel muted">Loading…</div>}
    </div>
  );
}
