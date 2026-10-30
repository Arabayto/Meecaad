import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AppShell, visibleNav } from './layouts/AppShell';
import { useAuth, type Perm } from './contexts/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { SellPage } from './pages/SellPage';
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
import { AuditPage } from './pages/AuditPage';

function Protected() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div style={{ display: 'flex', height: '100vh', justifyContent: 'center', alignItems: 'center', background: '#f4fbf4' }}>
        <p style={{ color: '#066006', fontWeight: 500 }}>Loading Meecaad…</p>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <AppShell><Outlet /></AppShell>;
}

/** Renders the page only for users holding one of the permissions. */
function Need({ perms, children }: { perms: Perm[]; children: JSX.Element }) {
  const { can } = useAuth();
  return perms.some(can) ? children : <Home />;
}

/** Landing page: the owner dashboard, or the first page this user can use. */
function Home() {
  const { can, businesses, business } = useAuth();
  if (can('reports')) return <DashboardPage />;
  const kind = businesses.find((b) => b.id === business)?.kind ?? '';
  const first = visibleNav(can, kind)[0];
  return first ? <Navigate to={first.path} replace /> : <div className="mc-note">Your account has no pages assigned. Ask the owner.</div>;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<Protected />}>
          <Route path="/" element={<Home />} />
          <Route path="/sell" element={<Need perms={['sell']}><SellPage /></Need>} />
          <Route path="/sales" element={<Need perms={['sell', 'reports']}><SalesPage /></Need>} />
          <Route path="/fuel" element={<Need perms={['fuel', 'reports']}><FuelPage /></Need>} />
          <Route path="/stock" element={<Need perms={['stock', 'catalog']}><StockPage /></Need>} />
          <Route path="/purchases" element={<Need perms={['purchase']}><PurchasesPage /></Need>} />
          <Route path="/expenses" element={<Need perms={['expense']}><ExpensesPage /></Need>} />
          <Route path="/customers" element={<Need perms={['sell', 'reports', 'fuel']}><PartiesPage kind="customers" /></Need>} />
          <Route path="/suppliers" element={<Need perms={['purchase']}><PartiesPage kind="suppliers" /></Need>} />
          <Route path="/money" element={<Need perms={['money', 'reports']}><MoneyPage /></Need>} />
          <Route path="/closing" element={<Need perms={['close']}><ClosingPage /></Need>} />
          <Route path="/reports" element={<Need perms={['reports']}><ReportsPage /></Need>} />
          <Route path="/users" element={<Need perms={['users']}><UsersPage /></Need>} />
          <Route path="/audit" element={<Need perms={['users']}><AuditPage /></Need>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
