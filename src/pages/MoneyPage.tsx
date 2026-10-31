import { useState } from 'react';
import { ArrowRightLeft, Wallet } from 'lucide-react';
import { get, money, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../components/StatusBadge';
import { BizTag, DateRange, ErrorBox, Field, Money, MoneyInput, PageHeader, ReasonModal, addDays, fmtTime, useLoad, useSubmit } from '../components/ui';

const TYPE_LABEL: Record<string, string> = {
  customer_payment: 'Debt collected', supplier_payment: 'Supplier paid', transfer: 'Transfer', owner_in: 'Owner added money', owner_out: 'Owner took money',
};

export function MoneyPage() {
  const { businesses: allBusinesses, business, businessName, activeMethods, today, can } = useAuth();
  // In a business portal: that business's accounts only. The owner admin sees all three.
  const businesses = business ? allBusinesses.filter((b) => b.id === business) : allBusinesses;
  const scope = business || 'all';
  const balances = useLoad(() => get('/balances', { business: scope }), [scope]);
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const list = useLoad(() => get('/money', { business: scope, from, to }), [scope, from, to]);
  const [type, setType] = useState('transfer');
  const home = business || allBusinesses[0]?.id || '';
  const [f, setF] = useState({ business: home, method: 'cash', toBusiness: home, toMethod: 'zaad', amount: '', note: '', date: today });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const [voiding, setVoiding] = useState<any>(null);
  const { run, busy } = useSubmit();

  const methods = [...new Set((balances.data?.cash ?? []).map((c: any) => c.method_name))] as string[];
  const bal = (b: string, m: string) => balances.data?.cash.find((c: any) => c.business_id === b && c.method_name === m)?.balance ?? 0;
  const save = async () => {
    const r = await run((key) => post('/money', { type, ...f, amount: toCents(f.amount) }, key), 'Saved');
    if (r) { set('amount', ''); set('note', ''); balances.reload(); list.reload(); }
  };
  const reload = () => { balances.reload(); list.reload(); };

  return (
    <div className="module-page">
      <PageHeader icon={<Wallet size={22} />} title={business ? `Money — ${businessName(business)}` : 'Money & transfers — all businesses'} subtitle={business ? 'How much money this business has, in cash and in each mobile money account' : 'How much money each business has, in cash and in each mobile money account'} />
      <div className="panel">
        <ErrorBox error={balances.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Business</th>{methods.map((m) => <th key={m} className="num">{m}</th>)}<th className="num">Total money</th></tr></thead>
            <tbody>
              {businesses.map((b) => (
                <tr key={b.id}><td><BizTag id={b.id} /></td>{methods.map((m) => <td key={m} className="num"><Money c={bal(b.id, m)} /></td>)}
                  <td className="num"><Money c={methods.reduce((s, m) => s + bal(b.id, m), 0)} strong /></td></tr>
              ))}
              {!business && <tr><td><strong>All</strong></td>{methods.map((m) => <td key={m} className="num"><strong><Money c={businesses.reduce((s, b) => s + bal(b.id, m), 0)} /></strong></td>)}
                <td className="num"><Money c={(balances.data?.cash ?? []).reduce((s: number, c: any) => s + c.balance, 0)} strong /></td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>Balances are calculated from every saved sale, payment, expense and transfer. Count the real cash in Daily Closing to check them.</p>
      </div>

      {can('money') && (
        <div className="panel">
          <div className="panel__header"><div><p>Move money</p><h2>Transfers and owner money</h2></div></div>
          <div className="scope-tabs" style={{ marginBottom: 12 }}>
            <button type="button" className={type === 'transfer' ? 'active' : ''} onClick={() => setType('transfer')}>Transfer between accounts</button>
            <button type="button" className={type === 'owner_in' ? 'active' : ''} onClick={() => setType('owner_in')}>Owner adds money</button>
            <button type="button" className={type === 'owner_out' ? 'active' : ''} onClick={() => setType('owner_out')}>Owner takes money</button>
          </div>
          <div className="form-stack">
            <div className="form-row">
              <Field label={type === 'transfer' ? 'From business' : 'Business'}>{business
                ? <div className="form-input" style={{ display: 'flex', alignItems: 'center' }}>{businessName(business)}</div>
                : <select className="form-select" value={f.business} onChange={(e) => set('business', e.target.value)}>
                    {allBusinesses.map((b) => <option key={b.id} value={b.id}>{businessName(b.id)}</option>)}</select>}</Field>
              <Field label={type === 'transfer' ? 'From account' : 'Account'}><select className="form-select" value={f.method} onChange={(e) => set('method', e.target.value)}>
                {activeMethods.map((m) => <option key={m.id} value={m.id}>{m.name} ({money(bal(f.business, m.name))})</option>)}</select></Field>
            </div>
            {type === 'transfer' && (
              <div className="form-row">
                <Field label="To business"><select className="form-select" value={f.toBusiness} onChange={(e) => set('toBusiness', e.target.value)}>
                  {allBusinesses.map((b) => <option key={b.id} value={b.id}>{businessName(b.id)}</option>)}</select></Field>
                <Field label="To account"><select className="form-select" value={f.toMethod} onChange={(e) => set('toMethod', e.target.value)}>
                  {activeMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
              </div>
            )}
            <div className="form-row-3">
              <Field label="Amount"><MoneyInput value={f.amount} onChange={(v) => set('amount', v)} /></Field>
              <Field label="Date"><input type="date" className="form-input" value={f.date} max={today} onChange={(e) => set('date', e.target.value)} /></Field>
              <Field label="Note"><input className="form-input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder={type === 'transfer' ? 'e.g. Cash deposited to Zaad' : ''} /></Field>
            </div>
            <div className="mc-note">
              {type === 'transfer' ? 'A transfer only moves money. It is not counted as a sale or an expense.' :
                type === 'owner_in' ? 'Money the owner puts in (e.g. starting cash). It is not a sale.' : 'Money the owner takes out for personal use. It is not a business expense.'}
            </div>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" disabled={busy || toCents(f.amount) <= 0 || (type === 'transfer' && f.business === f.toBusiness && f.method === f.toMethod)} onClick={save}>
                <ArrowRightLeft size={16} /> Save
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel__header"><div><p>History</p><h2>Payments, transfers and owner money</h2></div><DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} /></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Type</th><th>Business</th><th>Details</th><th className="num">Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(list.data ?? []).map((m: any) => (
                <tr key={m.id}>
                  <td className="small">{m.entry_date}<div className="muted">{fmtTime(m.created_at)} · {m.created_by_name}</div></td>
                  <td>{TYPE_LABEL[m.type]}</td>
                  <td><BizTag id={m.business_id} />{m.to_business_id && m.to_business_id !== m.business_id && <> → <BizTag id={m.to_business_id} /></>}</td>
                  <td className="small">{m.method_name}{m.to_method_name && ` → ${m.to_method_name}`}{m.customer_name && ` · ${m.customer_name}`}{m.supplier_name && ` · ${m.supplier_name}`}{m.note && ` · ${m.note}`}</td>
                  <td className="num"><Money c={m.amount} /></td>
                  <td>{m.status === 'voided' ? <><StatusBadge label="Cancelled" tone="red" /><div className="small muted">{m.void_reason}</div></> : <StatusBadge label="Done" tone="green" />}</td>
                  <td>{can('void') && m.status === 'completed' && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setVoiding(m)}>Cancel</button>}</td>
                </tr>
              ))}
              {!list.loading && !list.data?.length && <tr><td colSpan={7} className="muted">Nothing in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {voiding && <ReasonModal open onClose={() => setVoiding(null)} title={`Cancel ${TYPE_LABEL[voiding.type].toLowerCase()}?`} action={`/money/${voiding.id}/void`} confirmLabel="Cancel it"
        message={<>{money(voiding.amount)} on {voiding.entry_date}. The money movement is reversed.</>} onDone={reload} />}
    </div>
  );
}
