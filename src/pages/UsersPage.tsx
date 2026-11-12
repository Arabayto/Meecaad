// Users & roles (owner only): one account per person, with a role in each
// business they work in. Also: who signed in when, signing a person out on
// every device, unlocking an account after wrong passwords.
import { useState } from 'react';
import { KeyRound, LogOut, Plus, ShieldCheck, Unlock, Users } from 'lucide-react';
import { get, patch, post } from '../api';
import { useAuth, BIZ_ROLE_PERMS, BUSINESS_FEATURES, ROLE_LABELS, PORTALS, type BizRole, type Perm, type PortalId } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { BizTag, ErrorBox, Field, PageHeader, fmtTime, useFilters, useLoad, useSubmit } from '../components/ui';

const ROLE_HELP: Record<string, string> = {
  manager: 'Runs this business: sales, expenses, cancellations, menu/products and reports',
  cashier: 'Takes payments and pays small expenses; closes their own shift',
  staff: 'Takes orders and payments (store: also stock usage; fuel station: pump readings)',
};
const PERM_LABEL: Record<Perm, string> = {
  sell: 'Take orders & payments', fuel: 'Pump readings', stock: 'Stock', purchase: 'Purchases', expense: 'Record expenses', close: 'Daily closing',
  void: 'Cancel / return / reopen', catalog: 'Menu, products & prices', money: 'Money & transfers', reports: 'Dashboard, reports & closings', users: 'Users & roles',
};
const BIZ_ROLES: BizRole[] = ['manager', 'cashier', 'staff'];
const PASSWORD_HINT = 'At least 8 characters, letters and numbers, not the username';

const since = (ts: string | null) => (ts ? fmtTime(ts) + ' · ' + ts.slice(0, 10) : 'Never');

export function UsersPage() {
  const { user, business, businessName } = useAuth();
  const [tab, setTab] = useState<'people' | 'roles' | 'signins'>('people');
  const users = useLoad(() => get('/users'), []);
  const [edit, setEdit] = useState<any>(null);
  const [pw, setPw] = useState(false);
  const [confirm, setConfirm] = useState<{ u: any; kind: 'signout' | 'unlock' } | null>(null);
  const { run, busy } = useSubmit();

  // Inside a business portal: that business's people (and the owners).
  const rows = (users.data ?? []).filter((u: any) => !business || u.owner || u.access[business]);
  const filter = useFilters<any>(rows, [
    ...(business ? [] : [{ key: 'biz', label: 'Business', get: (u: any) => (u.owner ? 'All (owner)' : Object.keys(u.access).map(businessName).join(' + ')) }]),
    { key: 'role', label: 'Role', get: (u: any) => (u.owner ? 'Owner' : business ? ROLE_LABELS[u.access[business]] : [...new Set(Object.values(u.access).map((r) => ROLE_LABELS[r as string]))].join(' + ')) },
    { key: 'status', label: 'Status', get: (u: any) => (!u.active ? 'Disabled' : u.locked_until ? 'Locked' : 'Active') },
  ], (u: any) => `${u.full_name} ${u.username} ${u.phone ?? ''}`, 'Search name, username, phone');

  const act = async () => {
    if (!confirm) return;
    const { u, kind } = confirm;
    const r = await run(() => (kind === 'signout' ? post(`/users/${u.id}/signout`, {}) : patch(`/users/${u.id}`, { unlock: true })),
      kind === 'signout' ? `${u.full_name} is signed out on every device` : `${u.full_name} can sign in again`);
    if (r) { setConfirm(null); users.reload(); }
  };

  return (
    <div className="module-page">
      <PageHeader icon={<Users size={22} />} title="Users & roles"
        subtitle={business ? `People who work in the ${businessName(business)} — one account per person, used in every business they work in` : 'One account per person, with a role in each business they work in'}
        actions={<>
          <button type="button" className="btn btn-secondary" onClick={() => setPw(true)}><KeyRound size={16} /> My password</button>
          <button type="button" className="btn btn-primary" onClick={() => setEdit({ access: business ? { [business]: 'cashier' } : {} })}><Plus size={16} /> Add employee</button>
        </>} />
      <div className="scope-tabs">
        <button type="button" className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>People</button>
        <button type="button" className={tab === 'roles' ? 'active' : ''} onClick={() => setTab('roles')}>What each role can do</button>
        <button type="button" className={tab === 'signins' ? 'active' : ''} onClick={() => setTab('signins')}>Sign-in history</button>
      </div>

      {tab === 'people' && (
        <div className="panel">
          <ErrorBox error={users.error} />
          {filter.bar}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Username</th><th>Access</th><th>Last signed in</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {filter.shown.map((u: any) => (
                  <tr key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
                    <td><strong>{u.full_name}</strong>{u.phone && <div className="small muted">{u.phone}</div>}</td>
                    <td>{u.username}</td>
                    <td>{u.owner ? <StatusBadge label="Owner — all businesses" tone="green" /> : (
                      <div className="row">{Object.entries(u.access).map(([b, r]) => <span key={b} className="row small"><BizTag id={b} /> {ROLE_LABELS[r as string]}</span>)}</div>
                    )}</td>
                    <td className="small">{since(u.last_login_at)}{u.sessions > 0 && <div className="muted">signed in on {u.sessions} {u.sessions === 1 ? 'device' : 'devices'}</div>}</td>
                    <td>{!u.active ? <StatusBadge label="Disabled" /> : u.locked_until ? <><StatusBadge label="Locked" tone="red" /><div className="small muted">wrong passwords · until {fmtTime(u.locked_until)}</div></> : <StatusBadge label="Active" tone="green" />}</td>
                    <td>
                      <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                        {u.id !== user?.id && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEdit(u)}>Edit</button>}
                        {u.locked_until && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setConfirm({ u, kind: 'unlock' })}><Unlock size={12} /> Unlock</button>}
                        {u.id !== user?.id && u.sessions > 0 && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setConfirm({ u, kind: 'signout' })}><LogOut size={12} /> Sign out</button>}
                      </div>
                    </td>
                  </tr>
                ))}
                {!users.loading && !filter.shown.length && <tr><td colSpan={6} className="muted">{filter.active ? 'Nobody matches.' : 'No employees yet.'}</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Employees sign in at their business's own page, e.g. /restaurant/login. A person working in two businesses uses the same account in both. Disabling someone keeps everything they recorded.</p>
        </div>
      )}
      {tab === 'roles' && <RolesTab />}
      {tab === 'signins' && <SignInsTab />}

      {edit && <UserModal u={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); users.reload(); }} />}
      {pw && <PasswordModal onClose={() => setPw(false)} />}
      <Modal open={Boolean(confirm)} onClose={() => setConfirm(null)} title={confirm?.kind === 'signout' ? `Sign ${confirm?.u.full_name} out everywhere?` : `Unlock ${confirm?.u.full_name}?`} width="sm"
        footer={<><button type="button" className="btn btn-secondary" onClick={() => setConfirm(null)}>Back</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={act}>{confirm?.kind === 'signout' ? 'Sign out' : 'Unlock'}</button></>}>
        <p>{confirm?.kind === 'signout'
          ? 'They are signed out on every phone and computer (e.g. a lost phone). They can sign in again with their password.'
          : 'The account was locked for 15 minutes after 5 wrong passwords. Unlock it only if you know it was really them.'}</p>
      </Modal>
    </div>
  );
}

/** What each role may do in each business (the server enforces the same table). */
function RolesTab() {
  const { business, businesses } = useAuth();
  const list = businesses.filter((b) => !business || b.id === business);
  return (
    <div className="form-stack">
      {list.map((b) => {
        const perms = (BUSINESS_FEATURES[b.id] ?? []).filter((p) => p !== 'users');
        return (
          <div key={b.id} className="panel">
            <div className="panel__header"><div><p>Roles in</p><h2>{PORTALS[b.id as PortalId].short}</h2></div></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Can…</th><th className="center">Owner</th>{BIZ_ROLES.map((r) => <th key={r} className="center">{ROLE_LABELS[r]}</th>)}</tr></thead>
                <tbody>
                  {perms.map((p) => (
                    <tr key={p}><td>{PERM_LABEL[p]}</td><td className="center">✓</td>
                      {BIZ_ROLES.map((r) => <td key={r} className="center">{BIZ_ROLE_PERMS[r][b.id]?.includes(p) ? '✓' : <span className="muted">—</span>}</td>)}</tr>
                  ))}
                  <tr><td>Users & roles, owner admin</td><td className="center">✓</td>{BIZ_ROLES.map((r) => <td key={r} className="center"><span className="muted">—</span></td>)}</tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      <p className="small muted"><ShieldCheck size={14} style={{ verticalAlign: -2 }} /> Everyone signs in with their own account; everything they record shows their name. Sessions end after 12 hours without use. 5 wrong passwords lock an account for 15 minutes.</p>
    </div>
  );
}

function SignInsTab() {
  const list = useLoad(() => get('/signins'), []);
  const filter = useFilters<any>(list.data ?? [], [
    { key: 'who', label: 'Person', get: (a) => a.full_name ?? `Unknown: ${a.username}` },
    { key: 'ok', label: 'Result', get: (a) => (a.ok ? 'Signed in' : 'Wrong password / unknown user') },
  ], (a) => `${a.username} ${a.full_name ?? ''} ${a.ip}`, 'Search name, username, address');
  return (
    <div className="panel">
      <p className="small muted">The last 200 sign-in attempts. Many failures for an unknown username or from one address can mean someone is guessing passwords.</p>
      <ErrorBox error={list.error} />
      {filter.bar}
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Person</th><th>Username typed</th><th>Result</th><th>Address</th></tr></thead>
          <tbody>
            {filter.shown.map((a: any) => (
              <tr key={a.id}><td className="small">{since(a.created_at)}</td><td>{a.full_name ?? <span className="muted">Unknown</span>}</td><td>{a.username}</td>
                <td>{a.ok ? <StatusBadge label="Signed in" tone="green" /> : <StatusBadge label="Failed" tone="red" />}</td><td className="small muted">{a.ip}</td></tr>
            ))}
            {!list.loading && !filter.shown.length && <tr><td colSpan={5} className="muted">Nothing yet.</td></tr>}
          </tbody>
        </table>
      </div>
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
          <Field label="Username (for signing in)" hint={isNew ? 'Letters and numbers, no spaces' : undefined}><input className="form-input" value={f.username} disabled={!isNew} onChange={(e) => setF({ ...f, username: e.target.value.replace(/\s/g, '') })} autoCapitalize="none" /></Field>
          <Field label={isNew ? 'Password' : 'New password (leave empty to keep)'} hint={PASSWORD_HINT}><input className="form-input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
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
        {!isNew && <p className="small muted" style={{ margin: 0 }}>Changing the role, password or blocking signs this person out on every device.</p>}
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
        <button type="button" className="btn btn-primary" disabled={busy || newPassword.length < 8} onClick={async () => { if (await run(() => post('/auth/password', { currentPassword, newPassword }), 'Password changed — other devices are signed out')) onClose(); }}>Save</button></>}>
      <div className="form-stack">
        <Field label="Current password"><input className="form-input" type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="New password" hint={PASSWORD_HINT}><input className="form-input" type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" /></Field>
      </div>
    </Modal>
  );
}
