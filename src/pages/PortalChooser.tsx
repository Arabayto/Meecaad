import { Link, Navigate, useLocation } from 'react-router-dom';
import { ArrowRight, LogOut, ShieldCheck } from 'lucide-react';
import { useAuth, PORTALS, type PortalId } from '../contexts/AuthContext';
import { PORTAL_ICON } from '../layouts/AppShell';
import { LoginPage, LOGIN_CSS } from './LoginPage';

const DESCRIPTION: Record<PortalId, string> = {
  restaurant: 'Orders, tables, menu, kitchen stock',
  store: 'Point of sale, products, stock, purchases',
  fuel: 'Pumps, shifts, tanks, deliveries',
  admin: 'All businesses together, users, settings',
};

/**
 * The front door: pick a portal. Signed out: each portal's own sign-in page.
 * Signed in: the portals this account may open (one portal → straight in).
 */
export function PortalChooser() {
  const { user, loading, setupRequired, portals, logout } = useAuth();
  const location = useLocation();
  const denied = (location.state as any)?.denied as PortalId | undefined;
  if (loading) return null;
  if (setupRequired) return <LoginPage />;
  if (user && portals.length === 1 && !denied) return <Navigate to={`/${portals[0]}`} replace />;
  const list: PortalId[] = user ? portals : ['restaurant', 'store', 'fuel', 'admin'];
  return (
    <>
      <style>{LOGIN_CSS + CHOOSER_CSS}</style>
      <div className="login-root">
        <div className="login-bg-pattern" />
        <div className="login-card chooser-card">
          <div className="login-logo-wrap">
            <div className="login-logo-ring"><img src="/logo.svg" alt="Meecaad" /></div>
            <h1 className="login-title">Meecaad</h1>
            <p className="login-subtitle">{user ? `Welcome, ${user.full_name}. Choose where to work.` : 'Choose your business to sign in'}</p>
          </div>
          {denied && <div className="login-error">Your account does not have access to {PORTALS[denied].short}.</div>}
          {user && !portals.length && <div className="login-error">Your account has no business assigned. Ask the owner.</div>}
          <div className="chooser-list">
            {list.map((id) => {
              const Icon = PORTAL_ICON[id];
              return (
                <Link key={id} to={user ? `/${id}` : `/${id}/login`} className={`chooser-item chooser-item--${id}`}>
                  <span className="chooser-icon"><Icon size={22} /></span>
                  <span className="chooser-text"><strong>{PORTALS[id].short}</strong><small>{DESCRIPTION[id]}</small></span>
                  <ArrowRight size={16} />
                </Link>
              );
            })}
          </div>
          {user && <button type="button" className="chooser-logout" onClick={() => logout()}><LogOut size={14} /> Sign out</button>}
          <div className="login-footer"><ShieldCheck size={14} /> One account for every business you work in</div>
        </div>
      </div>
    </>
  );
}

const CHOOSER_CSS = `
  .chooser-card { max-width: 460px; }
  .chooser-list { display: grid; gap: 10px; }
  .chooser-item { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; color: #0f172a; transition: all .2s; }
  .chooser-item:hover { border-color: #0b8f08; box-shadow: 0 4px 14px rgba(11,143,8,.12); }
  .chooser-icon { width: 42px; height: 42px; border-radius: 10px; display: grid; place-items: center; background: #e9f6e8; color: #066006; flex-shrink: 0; }
  .chooser-item--admin .chooser-icon { background: #fef9c3; color: #854d0e; }
  .chooser-text { flex: 1; display: grid; }
  .chooser-text small { color: #64748b; font-size: 12.5px; }
  .chooser-logout { margin: 18px auto 0; display: flex; gap: 6px; align-items: center; background: none; border: none; color: #64748b; cursor: pointer; font-size: 13px; }
`;
