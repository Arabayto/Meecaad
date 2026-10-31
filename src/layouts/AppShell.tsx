import { useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3, BookOpen, ClipboardCheck, Coffee, FileClock, Fuel, Home, LogOut, Menu, PackageSearch, Receipt, ShoppingBag, ShoppingCart,
  Store, Truck, UserCheck, Users, Wallet, X,
} from 'lucide-react';
import { useAuth, ROLE_LABELS, type Perm } from '../contexts/AuthContext';
import { ErrorBoundary } from '../components/ErrorBoundary';

interface NavItem { label: string; path: string; icon: typeof Home; perms: Perm[]; kinds?: string[] }

// Shown when the user holds any of `perms`, and (if set) only for these business kinds.
export const NAV: NavItem[] = [
  { label: 'Owner Dashboard', path: '/', icon: Home, perms: ['reports'] },
  { label: 'Sell', path: '/sell', icon: ShoppingCart, perms: ['sell'], kinds: ['restaurant', 'store'] },
  { label: 'Fuel Station', path: '/fuel', icon: Fuel, perms: ['fuel'], kinds: ['fuel'] },
  { label: 'Sales History', path: '/sales', icon: Receipt, perms: ['sell', 'reports'], kinds: ['restaurant', 'store'] },
  { label: 'Stock & Products', path: '/stock', icon: PackageSearch, perms: ['stock', 'catalog'] },
  { label: 'Purchases', path: '/purchases', icon: Truck, perms: ['purchase'] },
  { label: 'Expenses', path: '/expenses', icon: ShoppingBag, perms: ['expense'] },
  { label: 'Customers & Debts', path: '/customers', icon: UserCheck, perms: ['sell', 'reports', 'fuel'] },
  { label: 'Suppliers', path: '/suppliers', icon: Users, perms: ['purchase'] },
  { label: 'Money & Accounts', path: '/money', icon: Wallet, perms: ['money', 'reports'] },
  { label: 'Daily Closing', path: '/closing', icon: ClipboardCheck, perms: ['close'] },
  { label: 'Reports', path: '/reports', icon: BarChart3, perms: ['reports'] },
  { label: 'Users & Settings', path: '/users', icon: BookOpen, perms: ['users'] },
  { label: 'Audit Log', path: '/audit', icon: FileClock, perms: ['users'] },
];

const BIZ_ICON = { restaurant: Coffee, fuel: Fuel, store: Store } as const;

export function visibleNav(can: (p: Perm) => boolean, kind: string) {
  return NAV.filter((n) => n.perms.some(can) && (!n.kinds || n.kinds.includes(kind)));
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout, can, businesses, business, setBusiness, businessName } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const kind = businesses.find((b) => b.id === business)?.kind ?? '';
  const items = visibleNav(can, kind);
  const current = NAV.find((n) => (n.path === '/' ? location.pathname === '/' : location.pathname.startsWith(n.path)));

  const switchBusiness = (id: string) => {
    setBusiness(id);
    setMobileOpen(false);
    const nextKind = businesses.find((b) => b.id === id)?.kind ?? '';
    // Stay on the same page when it exists for the other business.
    if (current && current.kinds && !current.kinds.includes(nextKind)) navigate(visibleNav(can, nextKind)[0]?.path ?? '/');
  };

  return (
    <div className="app-shell">
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />}
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="brand">
          <div className="brand__logo"><img src="/logo.svg" alt="Meecaad" /></div>
          <div className="brand__text"><strong>Meecaad</strong></div>
          <button type="button" className="sidebar-close-btn" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X size={20} /></button>
        </div>

        {businesses.length > 0 && (
          <div className="biz-switch">
            <span className="biz-switch__label">Working in</span>
            {businesses.map((b) => {
              const Icon = BIZ_ICON[b.kind];
              return (
                <button key={b.id} type="button" className={b.id === business ? 'active' : ''} onClick={() => switchBusiness(b.id)}>
                  <Icon size={16} /> {businessName(b.id)}
                </button>
              );
            })}
          </div>
        )}

        <nav className="sidebar-nav">
          <div className="sidebar-nav-main">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink key={item.path} to={item.path} end={item.path === '/'} onClick={() => setMobileOpen(false)}
                  className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                  <Icon size={18} />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </div>
          <div className="sidebar-divider" />
          <button type="button" className="sidebar-logout" onClick={async () => { await logout(); navigate('/login'); }}>
            <LogOut size={18} />
            <span>Log Out</span>
          </button>
        </nav>
      </aside>

      <main className="main">
        <header className="topbar no-print">
          <div className="topbar__left">
            <button type="button" className="mobile-menu-btn" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu size={22} /></button>
            <div>
              <p>{current?.path === '/' || current?.path === '/reports' || current?.path === '/users' || current?.path === '/audit' ? 'Meecaad' : businessName(business)}</p>
              <h1>{current?.label ?? 'Meecaad'}</h1>
            </div>
          </div>
          <div className="topbar__actions">
            <div className="user-chip" title={user ? ROLE_LABELS[user.role] : ''}>
              {user?.full_name} <span className="muted small">· {user ? ROLE_LABELS[user.role] : ''}</span>
            </div>
          </div>
        </header>
        <div className="main-content"><ErrorBoundary resetKey={location.pathname + business}>{children}</ErrorBoundary></div>
      </main>
    </div>
  );
}
