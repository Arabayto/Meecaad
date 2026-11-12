import { useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3, BookOpen, ClipboardCheck, ClipboardList, Coffee, FileClock, Fuel, Gauge, Home, LayoutGrid, LogOut, Menu, PackageSearch, Receipt,
  Settings, ShoppingBag, ShoppingCart, Store, Truck, UserCheck, Users, Wallet, X,
} from 'lucide-react';
import { useAuth, PORTALS, ROLE_LABELS, type Perm, type PortalId } from '../contexts/AuthContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { useRefreshing } from '../components/ui';

export interface NavItem { label: string; path: string; icon: typeof Home; perms: Perm[] }

/** Each portal has its own navigation. Items show when the user holds any of `perms` in that business. */
export const PORTAL_NAV: Record<PortalId, NavItem[]> = {
  // A simple restaurant: take orders, get paid, keep the menu, expenses and debts.
  restaurant: [
    { label: 'New Order', path: '/orders', icon: LayoutGrid, perms: ['sell'] },
    { label: 'Orders', path: '/order-list', icon: ClipboardList, perms: ['sell'] },
    { label: 'Sales History', path: '/sales', icon: Receipt, perms: ['sell', 'reports'] },
    { label: 'Menu', path: '/menu', icon: Coffee, perms: ['catalog'] },
    { label: 'Expenses', path: '/expenses', icon: ShoppingBag, perms: ['expense'] },
    { label: 'Customers & Debts', path: '/customers', icon: UserCheck, perms: ['sell', 'reports'] },
  ],
  store: [
    { label: 'Dashboard', path: '/', icon: Home, perms: ['reports'] },
    { label: 'Point of Sale', path: '/sell', icon: ShoppingCart, perms: ['sell'] },
    { label: 'Sales & Returns', path: '/sales', icon: Receipt, perms: ['sell', 'reports'] },
    { label: 'Products & Stock', path: '/stock', icon: PackageSearch, perms: ['stock', 'catalog'] },
    { label: 'Purchases', path: '/purchases', icon: Truck, perms: ['purchase'] },
    { label: 'Expenses', path: '/expenses', icon: ShoppingBag, perms: ['expense'] },
    { label: 'Customers & Debts', path: '/customers', icon: UserCheck, perms: ['sell', 'reports'] },
    { label: 'Suppliers', path: '/suppliers', icon: Users, perms: ['purchase'] },
    { label: 'Money', path: '/money', icon: Wallet, perms: ['money'] },
    { label: 'Daily Closing', path: '/closing', icon: ClipboardCheck, perms: ['close'] },
    { label: 'Reports', path: '/reports', icon: BarChart3, perms: ['reports'] },
  ],
  fuel: [
    { label: 'Dashboard', path: '/', icon: Home, perms: ['reports'] },
    { label: 'Pumps & Shifts', path: '/pumps', icon: Gauge, perms: ['fuel', 'reports'] },
    { label: 'Fuel Types & Prices', path: '/fuels', icon: Fuel, perms: ['catalog'] },
    { label: 'Deliveries', path: '/purchases', icon: Truck, perms: ['purchase'] },
    { label: 'Expenses', path: '/expenses', icon: ShoppingBag, perms: ['expense'] },
    { label: 'Credit Customers', path: '/customers', icon: UserCheck, perms: ['fuel', 'reports'] },
    { label: 'Suppliers', path: '/suppliers', icon: Users, perms: ['purchase'] },
    { label: 'Money', path: '/money', icon: Wallet, perms: ['money'] },
    { label: 'Daily Closing', path: '/closing', icon: ClipboardCheck, perms: ['close'] },
    { label: 'Reports', path: '/reports', icon: BarChart3, perms: ['reports'] },
  ],
  admin: [
    { label: 'All Businesses', path: '/', icon: Home, perms: ['users'] },
    { label: 'Combined Reports', path: '/reports', icon: BarChart3, perms: ['users'] },
    { label: 'Money & Transfers', path: '/money', icon: Wallet, perms: ['users'] },
    { label: 'Customers', path: '/customers', icon: UserCheck, perms: ['users'] },
    { label: 'Suppliers', path: '/suppliers', icon: Users, perms: ['users'] },
    { label: 'Users & Roles', path: '/users', icon: BookOpen, perms: ['users'] },
    { label: 'Settings', path: '/settings', icon: Settings, perms: ['users'] },
    { label: 'Audit Log', path: '/audit', icon: FileClock, perms: ['users'] },
  ],
};

export const PORTAL_ICON: Record<PortalId, typeof Home> = { restaurant: Coffee, store: Store, fuel: Fuel, admin: Settings };

export function visibleNav(portal: PortalId, can: (p: Perm) => boolean) {
  return PORTAL_NAV[portal].filter((n) => n.perms.some(can));
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout, can, portal, portals, path, business } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const refreshing = useRefreshing();
  const id = portal!;
  const items = visibleNav(id, can);
  const rel = location.pathname.slice(id.length + 1) || '/';
  const current = PORTAL_NAV[id].find((n) => (n.path === '/' ? rel === '/' : rel === n.path || rel.startsWith(n.path + '/')));
  const Icon = PORTAL_ICON[id];
  const role = user?.owner ? 'owner' : user?.roles[business];

  return (
    <div className={`app-shell portal-${id}`}>
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />}
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="brand">
          <div className="brand__logo"><img src="/logo.svg" alt="Meecaad" /></div>
          <div className="brand__text"><strong>Meecaad</strong><span className="brand__portal">{PORTALS[id].short}</span></div>
          <button type="button" className="sidebar-close-btn" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X size={20} /></button>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-nav-main">
            {items.map((item) => {
              const ItemIcon = item.icon;
              return (
                <NavLink key={item.path} to={path(item.path)} end={item.path === '/'} onClick={() => setMobileOpen(false)}
                  className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                  <ItemIcon size={18} />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </div>
          <div className="sidebar-divider" />
          {portals.length > 1 && (
            <Link to="/" className="sidebar-link" onClick={() => setMobileOpen(false)}>
              <Icon size={18} /><span>Other portals</span>
            </Link>
          )}
          <button type="button" className="sidebar-logout" onClick={async () => { await logout(); navigate(`/${id}/login`); }}>
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
              <p>{PORTALS[id].name}</p>
              <h1>{current?.label ?? PORTALS[id].short}</h1>
            </div>
          </div>
          <div className="topbar__actions">
            <div className="user-chip" title={role ? ROLE_LABELS[role] : ''}>
              {user?.full_name} <span className="muted small">· {role ? ROLE_LABELS[role] : ''}</span>
            </div>
          </div>
        </header>
        <div className={`main-content${refreshing ? ' is-refreshing' : ''}`}>
          <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
