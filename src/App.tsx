import { BrowserRouter, Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom';
import { AppShell, visibleNav } from './layouts/AppShell';
import { PortalProvider, useAuth, type Perm, type PortalId } from './contexts/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { PortalChooser } from './pages/PortalChooser';
import { DashboardPage } from './pages/DashboardPage';
import { SellPage } from './pages/SellPage';
import { NewOrderPage, OrdersPage } from './pages/RestaurantPage';
import { RestaurantDashboard, RestaurantReports } from './pages/RestaurantReports';
import { ClosingsPage, ShiftPage } from './pages/ShiftPage';
import { SalesPage } from './pages/SalesPage';
import { StockPage } from './pages/StockPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { ExpensesPage } from './pages/ExpensesPage';
import { PartiesPage } from './pages/PartiesPage';
import { MoneyPage } from './pages/MoneyPage';
import { FuelPage } from './pages/FuelPage';
import { ClosingPage } from './pages/ClosingPage';
import { ReportsPage } from './pages/ReportsPage';
import { UsersPage } from './pages/UsersPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuditPage } from './pages/AuditPage';

const PORTAL_IDS: PortalId[] = ['restaurant', 'store', 'fuel', 'admin'];

function Loading() {
  return (
    <div style={{ display: 'flex', height: '100vh', justifyContent: 'center', alignItems: 'center', background: '#f4fbf4' }}>
      <p style={{ color: '#066006', fontWeight: 500 }}>Loading Meecaad…</p>
    </div>
  );
}

/**
 * One portal: signed in AND allowed into this business (or, for admin, the
 * owner). Everything below sees this portal's business only.
 */
function Portal() {
  const { portal } = useParams();
  const { user, loading, portals } = useAuth();
  const id = portal as PortalId;
  if (!PORTAL_IDS.includes(id)) return <Navigate to="/" replace />;
  if (loading) return <Loading />;
  if (!user) return <Navigate to={`/${id}/login`} replace />;
  if (!portals.includes(id)) return <Navigate to="/" replace state={{ denied: id }} />;
  return (
    <PortalProvider id={id}>
      {/* key: a different portal starts fresh (no cart or form carries over between businesses) */}
      <AppShell key={id}><Outlet /></AppShell>
    </PortalProvider>
  );
}

function PortalLogin() {
  const { portal } = useParams();
  return PORTAL_IDS.includes(portal as PortalId) ? <LoginPage portal={portal as PortalId} /> : <Navigate to="/" replace />;
}

/** The page only for users holding one of the permissions in this portal; otherwise the portal's home. */
function Need({ perms, children }: { perms: Perm[]; children: JSX.Element }) {
  const { can } = useAuth();
  return perms.some(can) ? children : <PortalHome />;
}

/** A portal's landing page: its dashboard, or the first page this user can use there. */
function PortalHome() {
  const { can, portal, path } = useAuth();
  if (portal === 'restaurant' && can('reports')) return <RestaurantDashboard />;
  if (portal === 'admin' || can('reports')) return <DashboardPage />;
  const first = visibleNav(portal!, can).find((n) => n.path !== '/');
  return first ? <Navigate to={path(first.path)} replace /> : <div className="mc-note">Your account has no pages in this portal. Ask the owner.</div>;
}

/** Pages that exist in a portal; anything else goes to that portal's home. */
function PortalPage() {
  const { page } = useParams();
  const { portal } = useAuth();
  const p = portal!;
  const pages: Record<string, [Perm[], JSX.Element]> = p === 'admin' ? {
    reports: [['users'], <ReportsPage />],
    money: [['users'], <MoneyPage />],
    customers: [['users'], <PartiesPage kind="customers" />],
    suppliers: [['users'], <PartiesPage kind="suppliers" />],
    users: [['users'], <UsersPage />],
    settings: [['users'], <SettingsPage />],
    audit: [['users'], <AuditPage />],
  } : p === 'restaurant' ? {
    // A simple restaurant: orders, sales, menu, expenses, customers, reports.
    orders: [['sell'], <NewOrderPage />],
    'order-list': [['sell'], <OrdersPage />],
    sales: [['sell', 'reports'], <SalesPage />],
    menu: [['catalog'], <StockPage view="menu" />],
    expenses: [['expense'], <ExpensesPage />],
    customers: [['sell', 'reports'], <PartiesPage kind="customers" />],
    reports: [['reports'], <RestaurantReports />],
    shift: [['sell'], <ShiftPage />],
    closings: [['reports'], <ClosingsPage />],
  } : {
    ...(p === 'fuel' ? {
      pumps: [['fuel', 'reports'], <FuelPage />],
      fuels: [['catalog'], <StockPage view="fuels" />],
    } : {
      sell: [['sell'], <SellPage />],
      sales: [['sell', 'reports'], <SalesPage />],
      stock: [['stock', 'catalog'], <StockPage view="products" />],
    }),
    purchases: [['purchase'], <PurchasesPage />],
    expenses: [['expense'], <ExpensesPage />],
    customers: [p === 'fuel' ? ['fuel', 'reports'] : ['sell', 'reports'], <PartiesPage kind="customers" />],
    suppliers: [['purchase'], <PartiesPage kind="suppliers" />],
    money: [['money'], <MoneyPage />],
    closing: [['close'], <ClosingPage />],
    reports: [['reports'], <ReportsPage />],
  } as Record<string, [Perm[], JSX.Element]>;
  const entry = pages[page ?? ''];
  if (!entry) return <Navigate to={`/${p}`} replace />;
  return <Need perms={entry[0]}>{entry[1]}</Need>;
}

export function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<PortalChooser />} />
        <Route path="/login" element={<PortalChooser />} />
        <Route path="/:portal/login" element={<PortalLogin />} />
        <Route path="/:portal" element={<Portal />}>
          <Route index element={<PortalHome />} />
          <Route path=":page" element={<PortalPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
