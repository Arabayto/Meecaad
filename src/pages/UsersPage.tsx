import { useState } from 'react';
import { KeyRound, Plus, Users } from 'lucide-react';
import { get, patch, post } from '../api';
import { useAuth, ROLE_LABELS, PORTALS, type BizRole, type PortalId } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { BizTag, ErrorBox, Field, PageHeader, useLoad, useSubmit } from '../components/ui';

const ROLE_HELP: Record<string, string> = {
  manager: 'Runs this business: sales, stock, purchases, expenses, closing, cancellations, reports',
  cashier: 'Sells (or records pump shifts at the fuel station), collects debts, closes the day',
  staff: 'Sells and records stock usage/waste (fuel station: pump readings and tank dips)',
};

export function UsersPage() {
  const { user } = useAuth();
  const users = useLoad(() => get('/users'), []);
  const [edit, setEdit] = useState<any>(null);
  const [pw, setPw] = useState(false);

  return (
    <div className="module-page">
      <PageHeader icon={<Users size={22} />} title="Users & roles" subtitle="One account per person, with a role in each business they work in"
        actions={<>
          <button type="button" className="btn btn-secondary" onClick={() => setPw(true)}><KeyRound size={16} /> My password</button>
          <button type="button" className="btn btn-primary" onClick={() => setEdit({ access: {} })}><Plus size={16} /> Add employee</button>
        </>} />
      <div className="panel">
        <ErrorBox error={users.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Username</th><th>Access</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(users.data ?? []).map((u: any) => (
                <tr key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
                  <td><strong>{u.full_name}</strong>{u.phone && <div className="small muted">{u.phone}</div>}</td>
                  <td>{u.username}</td>
                  <td>{u.owner ? <StatusBadge label="Owner — all businesses" tone="green" /> : (
                    <div className="row">{Object.entries(u.access).map(([b, r]) => <span key={b} className="row small"><BizTag id={b} /> {ROLE_LABELS[r as string]}</span>)}</div>
                  )}</td>
                  <td>{u.active ? <StatusBadge label="Active" tone="green" /> : <StatusBadge label="Disabled" />}</td>
                  <td>{u.id !== user?.id && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEdit(u)}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>Employees sign in at their business's own page, e.g. /store/login. A person working in two businesses uses the same account in both.</p>
      </div>

      {edit && <UserModal u={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); users.reload(); }} />}
      {pw && <PasswordModal onClose={() => setPw(false)} />}
    </div>
  );
}

function UserModal({ u, onClose, onDone }: { u: any; onClose: () => void; onDone: () => void }) {
  const { businesses } = useAuth();
  const isNew = !u.id;
  const [f, setF] = useState({
    fullName: u.full_name ?? '', username: u.username ?? '', phone: u.phone ?? '', owner: Boolean(u.owner),
    access: { ...(u.access ?? {}) } as Record<string, BizRole | ''>, password: '', active: u.active ?? 1,
  });
  const { run, busy } = useSubmit();
  const access = Object.fromEntries(Object.entries(f.access).filter(([, r]) => r));
  const save = async () => {
    const body = { ...f, access, active: Boolean(f.active) };
    const r = await run(() => (isNew ? post('/users', body) : patch(`/users/${u.id}`, body)), 'Saved');
    if (r) onDone();
  };
  return (
    <Modal open onClose={onClose} title={isNew ? 'Add employee' : `Edit ${u.full_name}`} width="md"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !f.fullName.trim() || !f.username.trim() || (isNew && f.password.length < 8) || (!f.owner && !Object.keys(access).length)} onClick={save}>Save</button></>}>
      <div className="form-stack">
        <div className="form-row">
          <Field label="Full name"><input className="form-input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} autoFocus /></Field>
          <Field label="Phone"><input className="form-input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        </div>
        <div className="form-row">
          <Field label="Username (for signing in)"><input className="form-input" value={f.username} disabled={!isNew} onChange={(e) => setF({ ...f, username: e.target.value })} autoCapitalize="none" /></Field>
          <Field label={isNew ? 'Password (min. 8 characters)' : 'New password (leave empty to keep)'}><input className="form-input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
        </div>
        <label className="row"><input type="checkbox" checked={f.owner} onChange={(e) => setF({ ...f, owner: e.target.checked })} /> Owner (full access to every business and the owner admin)</label>
        {!f.owner && (
          <Field label="Role in each business" hint="Leave a business on “No access” if this person does not work there.">
            <div className="table-wrap">
              <table>
                <tbody>
                  {businesses.map((b) => (
                    <tr key={b.id}>
                      <td><strong>{PORTALS[b.id as PortalId].short}</strong></td>
                      <td>
                        <select className="form-select" value={f.access[b.id] ?? ''} onChange={(e) => setF({ ...f, access: { ...f.access, [b.id]: e.target.value as BizRole | '' } })}>
                          <option value="">No access</option>
                          <option value="manager">Manager</option>
                          <option value="cashier">Cashier</option>
                          <option value="staff">Staff</option>
                        </select>
                      </td>
                      <td className="small muted">{f.access[b.id] ? ROLE_HELP[f.access[b.id] as string] : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
