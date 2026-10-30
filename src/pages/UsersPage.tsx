import { useState } from 'react';
import { KeyRound, Plus, Users } from 'lucide-react';
import { get, patch, post } from '../api';
import { useAuth, ROLE_LABELS } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { BizTag, ErrorBox, Field, PageHeader, useLoad, useSubmit } from '../components/ui';

const ROLE_HELP: Record<string, string> = {
  owner: 'Everything, all businesses',
  manager: 'Runs the chosen businesses: sales, stock, purchases, expenses, closing, cancellations, reports',
  cashier: 'Sells, collects debts and closes the day',
  restaurant_staff: 'Sells and records kitchen usage/waste in the restaurant',
  store_staff: 'Sells and records waste in the store',
  fuel_staff: 'Records pump readings, money received and tank dips',
};

export function UsersPage() {
  const { user, reload } = useAuth();
  const users = useLoad(() => get('/users'), []);
  const methods = useLoad(() => get('/payment-methods'), []);
  const [edit, setEdit] = useState<any>(null);
  const [newMethod, setNewMethod] = useState('');
  const [pw, setPw] = useState(false);
  const { run, busy } = useSubmit();

  const addMethod = async () => {
    const r = await run(() => post('/payment-methods', { name: newMethod }), 'Payment method added');
    if (r) { setNewMethod(''); methods.reload(); reload(); }
  };
  const toggleMethod = async (m: any) => {
    const r = await run(() => patch(`/payment-methods/${m.id}`, { active: !m.active }), 'Saved');
    if (r) { methods.reload(); reload(); }
  };

  return (
    <div className="module-page">
      <PageHeader icon={<Users size={22} />} title="Users & settings" subtitle="Who can use Meecaad and what they can do"
        actions={<>
          <button type="button" className="btn btn-secondary" onClick={() => setPw(true)}><KeyRound size={16} /> My password</button>
          <button type="button" className="btn btn-primary" onClick={() => setEdit({ role: 'cashier', businesses: [] })}><Plus size={16} /> Add employee</button>
        </>} />
      <div className="panel">
        <ErrorBox error={users.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Businesses</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(users.data ?? []).map((u: any) => (
                <tr key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
                  <td><strong>{u.full_name}</strong>{u.phone && <div className="small muted">{u.phone}</div>}</td>
                  <td>{u.username}</td>
                  <td>{ROLE_LABELS[u.role]}<div className="small muted">{ROLE_HELP[u.role]}</div></td>
                  <td><div className="row">{u.businesses.map((b: string) => <BizTag key={b} id={b} />)}</div></td>
                  <td>{u.active ? <StatusBadge label="Active" tone="green" /> : <StatusBadge label="Disabled" />}</td>
                  <td>{u.id !== user?.id && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEdit(u)}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel__header"><div><p>Settings</p><h2>Payment methods</h2></div></div>
        <div className="row" style={{ marginBottom: 12 }}>
          {(methods.data ?? []).map((m: any) => (
            <span key={m.id} className="row" style={{ border: '1px solid var(--border)', borderRadius: 20, padding: '4px 6px 4px 12px' }}>
              <strong style={{ opacity: m.active ? 1 : 0.5 }}>{m.name}</strong>
              {m.id !== 'cash' && <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => toggleMethod(m)}>{m.active ? 'Turn off' : 'Turn on'}</button>}
            </span>
          ))}
        </div>
        <div className="row">
          <input className="form-input" style={{ maxWidth: 240 }} placeholder="e.g. Bank, Sahal, Premier Wallet" value={newMethod} onChange={(e) => setNewMethod(e.target.value)} />
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !newMethod.trim()} onClick={addMethod}>Add method</button>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>Each method is a money account in every business (e.g. Store Zaad, Fuel Zaad). Methods with money in them are never deleted, only turned off.</p>
      </div>

      {edit && <UserModal u={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); users.reload(); }} />}
      {pw && <PasswordModal onClose={() => setPw(false)} />}
    </div>
  );
}

function UserModal({ u, onClose, onDone }: { u: any; onClose: () => void; onDone: () => void }) {
  const { businesses, businessName } = useAuth();
  const isNew = !u.id;
  const [f, setF] = useState({ fullName: u.full_name ?? '', username: u.username ?? '', phone: u.phone ?? '', role: u.role, businesses: u.businesses ?? [], password: '', active: u.active ?? 1 });
  const { run, busy } = useSubmit();
  const pickBusinesses = ['manager', 'cashier'].includes(f.role);
  const save = async () => {
    const body = { ...f, active: Boolean(f.active) };
    const r = await run(() => (isNew ? post('/users', body) : patch(`/users/${u.id}`, body)), 'Saved');
    if (r) onDone();
  };
  return (
    <Modal open onClose={onClose} title={isNew ? 'Add employee' : `Edit ${u.full_name}`} width="md"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !f.fullName.trim() || !f.username.trim() || (isNew && f.password.length < 8) || (pickBusinesses && !f.businesses.length)} onClick={save}>Save</button></>}>
      <div className="form-stack">
        <div className="form-row">
          <Field label="Full name"><input className="form-input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} autoFocus /></Field>
          <Field label="Phone"><input className="form-input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label="Username (for signing in)"><input className="form-input" value={f.username} disabled={!isNew} onChange={(e) => setF({ ...f, username: e.target.value })} autoCapitalize="none" /></Field>
          <Field label={isNew ? 'Password (min. 8 characters)' : 'New password (leave empty to keep)'}><input className="form-input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
        </div>
        <Field label="Role" hint={ROLE_HELP[f.role]}>
          <select className="form-select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {Object.entries(ROLE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        {pickBusinesses && (
          <Field label="Works in">
            <div className="row">{businesses.map((b) => (
              <label key={b.id} className="row small"><input type="checkbox" checked={f.businesses.includes(b.id)}
                onChange={(e) => setF({ ...f, businesses: e.target.checked ? [...f.businesses, b.id] : f.businesses.filter((x: string) => x !== b.id) })} /> {businessName(b.id)}</label>
            ))}</div>
          </Field>
        )}
        {!isNew && <label className="row"><input type="checkbox" checked={Boolean(f.active)} onChange={(e) => setF({ ...f, active: e.target.checked ? 1 : 0 })} /> Active (uncheck to block sign-in; their records stay)</label>}
      </div>
    </Modal>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const { run, busy } = useSubmit();
  return (
    <Modal open onClose={onClose} title="Change my password" width="sm"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || newPassword.length < 8} onClick={async () => { if (await run(() => post('/auth/password', { currentPassword, newPassword }), 'Password changed')) onClose(); }}>Save</button></>}>
      <div className="form-stack">
        <Field label="Current password"><input className="form-input" type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password (min. 8 characters)"><input className="form-input" type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" /></Field>
      </div>
    </Modal>
  );
}
