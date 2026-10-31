import { useState } from 'react';
import { Printer, UserCheck, Users } from 'lucide-react';
import { get, money, patch, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { BizTag, ErrorBox, Field, Money, MoneyInput, PageHeader, addDays, useLoad, useSubmit } from '../components/ui';

/** Customers (what they owe us) or suppliers (what we owe them), per business. */
export function PartiesPage({ kind }: { kind: 'customers' | 'suppliers' }) {
  const { business, businessName, businesses, can, today } = useAuth();
  const isCustomers = kind === 'customers';
  const [scope, setScope] = useState<'business' | 'all'>('business');
  const scopeId = scope === 'all' ? 'all' : business;
  const list = useLoad(() => get(`/${kind}`, { business: scopeId }), [kind, scopeId]);
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [paying, setPaying] = useState<any>(null);
  const [statement, setStatement] = useState<any>(null);

  const rows = (list.data ?? []).filter((c: any) => (showAll || c.balance !== 0 || search) && (!search || `${c.name} ${c.phone ?? ''}`.toLowerCase().includes(search.toLowerCase())));
  const total = (list.data ?? []).reduce((s: number, c: any) => s + c.balance, 0);
  const canPay = isCustomers ? can('sell') : can('purchase');
  const canEdit = isCustomers ? can('sell') : can('purchase');

  return (
    <div className="module-page">
      <PageHeader icon={isCustomers ? <UserCheck size={22} /> : <Users size={22} />}
        title={isCustomers ? 'Customers & debts' : 'Suppliers'}
        subtitle={`${isCustomers ? 'Customers owe' : 'We owe'} ${money(total)} — ${scope === 'all' ? 'all businesses' : businessName(business)}`}
        actions={canEdit && <button type="button" className="btn btn-primary" onClick={() => setEdit({})}>Add {isCustomers ? 'customer' : 'supplier'}</button>} />
      <div className="panel">
        <div className="row row--between" style={{ marginBottom: 12 }}>
          <div className="row">
            <input className="form-input" style={{ maxWidth: 260 }} placeholder="Search name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
            <label className="row small"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show everyone (also with zero balance)</label>
          </div>
          {businesses.length > 1 && (
            <div className="scope-tabs">
              <button type="button" className={scope === 'business' ? 'active' : ''} onClick={() => setScope('business')}>{businessName(business)}</button>
              <button type="button" className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All businesses</button>
            </div>
          )}
        </div>
        <ErrorBox error={list.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th className="num">{isCustomers ? 'Owes us' : 'We owe'}</th><th>Last {isCustomers ? 'credit' : 'purchase'}</th><th>Last payment</th><th></th></tr></thead>
            <tbody>
              {rows.map((c: any) => {
                const lastActivity = c.last_payment ?? c.last_charge;
                const overdue = isCustomers && c.balance > 0 && lastActivity && lastActivity < addDays(today, -30);
                return (
                  <tr key={c.id} style={{ opacity: c.active ? 1 : 0.5 }}>
                    <td><strong>{c.name}</strong> {overdue && <StatusBadge label="Overdue" tone="red" />}{c.notes && <div className="small muted">{c.notes}</div>}</td>
                    <td className="small">{c.phone}</td>
                    <td className="num"><Money c={c.balance} strong /></td>
                    <td className="small">{c.last_charge ?? '—'}</td>
                    <td className="small">{c.last_payment ?? '—'}</td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        {canPay && scope === 'business' && c.balance > 0 && <button type="button" className="btn btn-primary btn-xs" onClick={() => setPaying(c)}>{isCustomers ? 'Receive payment' : 'Pay'}</button>}
                        <button type="button" className="btn btn-ghost btn-xs" onClick={async () => setStatement(await get(`/${kind}/${c.id}/statement`, { business: scopeId }))}>Statement</button>
                        {canEdit && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEdit(c)}>Edit</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!list.loading && !rows.length && <tr><td colSpan={6} className="muted">{showAll ? 'Nobody added yet.' : `Nobody ${isCustomers ? 'owes money' : 'is owed money'}. Tick "Show everyone" to see all.`}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {edit && <EditModal kind={kind} party={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.reload(); }} />}
      {paying && <PayModal kind={kind} party={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); list.reload(); }} />}
      <Modal open={Boolean(statement)} onClose={() => setStatement(null)} title="Statement" width="lg"
        footer={<button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print</button>}>
        {statement && (
          <div className="print-area">
            <img className="print-only print-logo" src="/logo-full.svg" alt="Meecaad" />
            <h3 style={{ margin: '0 0 4px' }}>{(statement.customer ?? statement.supplier).name}</h3>
            <p className="muted small">{scope === 'all' ? 'All businesses' : businessName(business)} · balance {money(statement.balance)} {isCustomers ? 'owed to us' : 'we owe'}</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Business</th><th>Details</th><th className="num">{isCustomers ? 'Credit given' : 'Bought on credit'}</th><th className="num">Paid / returned</th><th className="num">Balance</th></tr></thead>
                <tbody>
                  {statement.lines.map((l: any, i: number) => (
                    <tr key={i}>
                      <td className="small">{l.entry_date}</td><td><BizTag id={l.business_id} /></td><td className="small">{l.memo}</td>
                      <td className="num">{l.amount > 0 ? money(l.amount) : ''}</td><td className="num">{l.amount < 0 ? money(-l.amount) : ''}</td>
                      <td className="num"><strong>{money(l.balance)}</strong></td>
                    </tr>
                  ))}
                  {!statement.lines.length && <tr><td colSpan={6} className="muted">No transactions.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function EditModal({ kind, party, onClose, onDone }: { kind: string; party: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: party.name ?? '', phone: party.phone ?? '', notes: party.notes ?? '', active: party.active ?? 1 });
  const { run, busy } = useSubmit();
  const save = async () => {
    const r = await run((key) => (party.id ? patch(`/${kind}/${party.id}`, f) : post(`/${kind}`, f, key)), 'Saved');
    if (r) onDone();
  };
  return (
    <Modal open onClose={onClose} title={party.id ? `Edit ${party.name}` : 'Add'} width="sm"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !f.name.trim()} onClick={save}>Save</button></>}>
      <div className="form-stack">
        <Field label="Name"><input className="form-input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="Phone"><input className="form-input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Notes"><input className="form-input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        {party.id && <label className="row"><input type="checkbox" checked={Boolean(f.active)} onChange={(e) => setF({ ...f, active: e.target.checked ? 1 : 0 })} /> Active</label>}
      </div>
    </Modal>
  );
}

function PayModal({ kind, party, onClose, onDone }: { kind: string; party: any; onClose: () => void; onDone: () => void }) {
  const { business, businessName, activeMethods, today } = useAuth();
  const isCustomers = kind === 'customers';
  const [amount, setAmount] = useState((party.balance / 100).toFixed(2));
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today);
  const { run, busy } = useSubmit();
  const save = async () => {
    const r = await run((key) => post('/money', {
      type: isCustomers ? 'customer_payment' : 'supplier_payment', business, date, method, amount: toCents(amount), note,
      [isCustomers ? 'customer' : 'supplier']: party.id,
    }, key), 'Payment saved');
    if (r) onDone();
  };
  return (
    <Modal open onClose={onClose} title={isCustomers ? `Receive payment from ${party.name}` : `Pay ${party.name}`} width="sm"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || toCents(amount) <= 0 || toCents(amount) > party.balance} onClick={save}>Save payment</button></>}>
      <div className="form-stack">
        <div className="mc-note">{isCustomers ? `${party.name} owes ${businessName(business)}` : `${businessName(business)} owes ${party.name}`} <strong>{money(party.balance)}</strong>. This payment reduces the debt — it is not a new sale{isCustomers ? '' : ' or expense'}.</div>
        <div className="form-row">
          <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} autoFocus /></Field>
          <Field label={isCustomers ? 'Received in' : 'Paid from'}><select className="form-select" value={method} onChange={(e) => setMethod(e.target.value)}>{activeMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        </div>
        <div className="form-row">
          <Field label="Date"><input type="date" className="form-input" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Note"><input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        {toCents(amount) > party.balance && <div className="mc-error">More than the balance.</div>}
      </div>
    </Modal>
  );
}
