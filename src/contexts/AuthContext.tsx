import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post, setUnauthorizedHandler } from '../api';

export type Perm = 'sell' | 'stock' | 'fuel' | 'purchase' | 'expense' | 'close' | 'void' | 'catalog' | 'money' | 'reports' | 'users';
export interface User { id: string; username: string; full_name: string; role: string; businesses: string[] }
export interface Business { id: string; name: string; kind: 'restaurant' | 'fuel' | 'store' }
export interface Method { id: string; name: string; active: number }

// Mirrors server/lib.ts ROLE_PERMS (the server enforces; this only hides what cannot be used).
const ROLE_PERMS: Record<string, Perm[]> = {
  owner: ['sell', 'stock', 'fuel', 'purchase', 'expense', 'close', 'void', 'catalog', 'money', 'reports', 'users'],
  manager: ['sell', 'stock', 'fuel', 'purchase', 'expense', 'close', 'void', 'catalog', 'money', 'reports'],
  cashier: ['sell', 'close'],
  restaurant_staff: ['sell', 'stock'],
  store_staff: ['sell', 'stock'],
  fuel_staff: ['fuel'],
};
export const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner', manager: 'Manager', cashier: 'Cashier', restaurant_staff: 'Restaurant staff', fuel_staff: 'Fuel station staff', store_staff: 'Store staff',
};

interface AuthValue {
  user: User | null;
  loading: boolean;
  setupRequired: boolean;
  businesses: Business[];
  methods: Method[];
  activeMethods: Method[];
  today: string;
  business: string;
  setBusiness: (id: string) => void;
  businessName: (id: string) => string;
  can: (perm: Perm) => boolean;
  login: (username: string, password: string) => Promise<void>;
  setup: (fullName: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [methods, setMethods] = useState<Method[]>([]);
  const [today, setToday] = useState('');
  const [business, setBusinessState] = useState<string>(() => { try { return localStorage.getItem('mc_business') ?? ''; } catch { return ''; } });

  const reload = useCallback(async () => {
    const boot = await get('/bootstrap');
    setUser(boot.user);
    setBusinesses(boot.businesses);
    setMethods(boot.methods);
    setToday(boot.today);
    setBusinessState((b) => (boot.user.businesses.includes(b) ? b : boot.user.businesses[0] ?? ''));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    get('/auth/me')
      .then(async (r) => { setSetupRequired(r.setupRequired); if (r.user) await reload(); })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [reload]);

  const setBusiness = (id: string) => {
    setBusinessState(id);
    try { localStorage.setItem('mc_business', id); } catch { /* storage unavailable */ }
  };

  const value: AuthValue = {
    user, loading, setupRequired, businesses, methods, today, business, setBusiness,
    activeMethods: methods.filter((m) => m.active),
    businessName: (id) => businesses.find((b) => b.id === id)?.name.replace('Meecaad ', '') ?? id,
    can: (perm) => Boolean(user && ROLE_PERMS[user.role]?.includes(perm)),
    login: async (username, password) => { await post('/auth/login', { username, password }); await reload(); },
    setup: async (fullName, username, password) => { await post('/auth/setup', { fullName, username, password }); setSetupRequired(false); await reload(); },
    logout: async () => { await post('/auth/logout').catch(() => null); setUser(null); },
    reload,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
