import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post, setUnauthorizedHandler } from '../api';

export type Perm = 'sell' | 'stock' | 'fuel' | 'purchase' | 'expense' | 'close' | 'void' | 'catalog' | 'money' | 'reports' | 'users';
export type BizRole = 'manager' | 'cashier' | 'staff';
export type PortalId = 'restaurant' | 'store' | 'fuel' | 'admin';
export interface User { id: string; username: string; full_name: string; role: string; owner: boolean; businesses: string[]; roles: Record<string, BizRole | 'owner'> }
export interface Business { id: string; name: string; kind: 'restaurant' | 'fuel' | 'store' }
export interface Method { id: string; name: string; active: number }

// Mirrors server/lib.ts BUSINESS_FEATURES and BIZ_ROLE_PERMS (the server enforces; this only hides what cannot be used).
const BUSINESS_FEATURES: Record<string, Perm[]> = {
  restaurant: ['sell', 'expense', 'void', 'catalog', 'money', 'reports', 'users'],
  store: ['sell', 'stock', 'purchase', 'expense', 'close', 'void', 'catalog', 'money', 'reports', 'users'],
  fuel: ['fuel', 'stock', 'purchase', 'expense', 'close', 'void', 'catalog', 'money', 'reports', 'users'],
};
const BIZ_ROLE_PERMS: Record<BizRole, Record<string, Perm[]>> = {
  manager: {
    restaurant: ['sell', 'expense', 'void', 'catalog', 'reports'],
    store: ['sell', 'stock', 'purchase', 'expense', 'close', 'void', 'catalog', 'money', 'reports'],
    fuel: ['fuel', 'stock', 'purchase', 'expense', 'close', 'void', 'catalog', 'money', 'reports'],
  },
  cashier: { restaurant: ['sell', 'expense'], store: ['sell', 'close'], fuel: ['fuel', 'close'] },
  staff: { restaurant: ['sell'], store: ['sell', 'stock'], fuel: ['fuel'] },
};
export const ROLE_LABELS: Record<string, string> = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier', staff: 'Staff' };
export const PORTALS: Record<PortalId, { name: string; short: string }> = {
  restaurant: { name: 'Meecaad Restaurant & Cafe', short: 'Restaurant & Cafe' },
  store: { name: 'Meecaad Store', short: 'Store' },
  fuel: { name: 'Meecaad Fuel Station', short: 'Fuel Station' },
  admin: { name: 'Meecaad Owner Admin', short: 'Owner Admin' },
};

interface AuthValue {
  user: User | null;
  loading: boolean;
  setupRequired: boolean;
  businesses: Business[];
  methods: Method[];
  activeMethods: Method[];
  today: string;
  /** Inside a business portal: that business. In the owner admin: '' (pages show all businesses). */
  business: string;
  portal: PortalId | null;
  businessName: (id: string) => string;
  /** Permission in the current portal's business (owner admin: owner only). */
  can: (perm: Perm) => boolean;
  canIn: (perm: Perm, business: string) => boolean;
  /** Portals this user may open. */
  portals: PortalId[];
  /** Path inside the current portal, e.g. path('/sell') → '/store/sell'. */
  path: (p: string) => string;
  login: (username: string, password: string) => Promise<void>;
  setup: (fullName: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);
const PortalCtx = createContext<PortalId | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [methods, setMethods] = useState<Method[]>([]);
  const [today, setToday] = useState('');

  const reload = useCallback(async () => {
    const boot = await get('/bootstrap');
    setUser(boot.user);
    setBusinesses(boot.businesses);
    setMethods(boot.methods);
    setToday(boot.today);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    get('/auth/me')
      .then(async (r) => { setSetupRequired(r.setupRequired); if (r.user) await reload(); })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [reload]);

  const canIn = useCallback((perm: Perm, business: string) => {
    if (!user) return false;
    if (user.owner) return Boolean(BUSINESS_FEATURES[business]?.includes(perm));
    const r = user.roles[business];
    return Boolean(r && r !== 'owner' && BIZ_ROLE_PERMS[r][business]?.includes(perm));
  }, [user]);

  const value: AuthValue = {
    user, loading, setupRequired, businesses, methods, today, business: '', portal: null,
    activeMethods: methods.filter((m) => m.active),
    businessName: (id) => businesses.find((b) => b.id === id)?.name.replace('Meecaad ', '') ?? id,
    can: (perm) => Boolean(user?.owner) || (perm !== 'users' && Boolean(user?.businesses.some((b) => canIn(perm, b)))),
    canIn,
    portals: user ? [...(['restaurant', 'store', 'fuel'] as PortalId[]).filter((p) => user.businesses.includes(p)), ...(user.owner ? ['admin' as PortalId] : [])] : [],
    path: (p) => p,
    login: async (username, password) => { await post('/auth/login', { username, password }); await reload(); },
    setup: async (fullName, username, password) => { await post('/auth/setup', { fullName, username, password }); setSetupRequired(false); await reload(); },
    logout: async () => { await post('/auth/logout').catch(() => null); setUser(null); },
    reload,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Everything inside renders for one portal: one business (or the owner admin). */
export function PortalProvider({ id, children }: { id: PortalId; children: ReactNode }) {
  return <PortalCtx.Provider value={id}>{children}</PortalCtx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  const portal = useContext(PortalCtx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  if (!portal) return v;
  const business = portal === 'admin' ? '' : portal;
  return {
    ...v,
    portal,
    business,
    can: (perm) => (business ? v.canIn(perm, business) : Boolean(v.user?.owner)),
    path: (p) => `/${portal}${p === '/' ? '' : p}`,
  };
}
