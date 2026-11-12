// Small shared building blocks used across Meecaad pages.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { StatusBadge } from './StatusBadge';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { CACHE_MAX, fromCents, money, pageCache, post, toCents } from '../api';

// Screens currently showing the previous selection's data while new data loads.
// AppShell fades the page a little meanwhile instead of blanking it.
const refreshing = new Set<object>();
const listeners = new Set<(on: boolean) => void>();
function setRefreshing(id: object, on: boolean) {
  const before = refreshing.size > 0;
  if (on) refreshing.add(id); else refreshing.delete(id);
  if (before !== refreshing.size > 0) listeners.forEach((l) => l(refreshing.size > 0));
}
export function useRefreshing() {
  const [on, setOn] = useState(refreshing.size > 0);
  useEffect(() => { listeners.add(setOn); return () => { listeners.delete(setOn); }; }, []);
  return on;
}

/**
 * Loads data and reloads when deps change. The last answer for the same request
 * is shown immediately and refreshed in the background (`fresh` turns true when
 * the server has answered). While data for a new selection loads, the previous
 * data stays on screen (marked `stale`) so the page does not jump or blank;
 * pages that look data up by the selection must use the selection the data
 * came back with. A slow older response can never overwrite a newer one.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const key = JSON.stringify(deps);
  const cacheKey = fn.toString() + '|' + key;   // same screen + same selection = same request
  const [state, setState] = useState<{ key: string; data: T | null; fresh: boolean }>(() =>
    ({ key, data: (pageCache.get(cacheKey) as T | undefined) ?? null, fresh: false }));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const id = useRef({});
  const reload = useCallback(() => {
    const req = ++latest.current;
    setLoading(true);
    return fn()
      .then((d) => {
        if (req !== latest.current) return;
        pageCache.delete(cacheKey);
        pageCache.set(cacheKey, d);
        if (pageCache.size > CACHE_MAX) pageCache.delete(pageCache.keys().next().value as string);
        setState({ key, data: d, fresh: true }); setError(null);
      })
      .catch((e) => { if (req === latest.current) setError(e.message); })
      .finally(() => { if (req === latest.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  // A new selection seen before: show its last answer straight away.
  const cached = state.key !== key ? (pageCache.get(cacheKey) as T | undefined) : undefined;
  const data = cached ?? state.data;
  const stale = state.data !== null && state.key !== key && cached === undefined;
  const fresh = state.key === key && state.fresh;
  useEffect(() => { setRefreshing(id.current, stale); }, [stale]);
  useEffect(() => () => setRefreshing(id.current, false), []);
  const setData = useCallback((d: T | null) => setState({ key, data: d, fresh: true }), [key]);
  return { data, stale, fresh, loading, error, reload, setData };
}

/**
 * Runs a save once at a time with a stable idempotency key: pressing the
 * button again (or a retry after a lost connection) cannot save twice.
 */
export function useSubmit() {
  const key = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const { addToast } = useToast();
  const run = useCallback(async <T,>(fn: (key: string) => Promise<T>, success?: string): Promise<T | undefined> => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn(key.current);
      key.current = crypto.randomUUID();
      if (success) addToast('success', success, 2500);
      return r;
    } catch (e: any) {
      addToast('error', e.message, 5000);
    } finally {
      setBusy(false);
    }
  }, [busy, addToast]);
  return { run, busy };
}

export function PageHeader({ icon, title, subtitle, actions }: { icon: ReactNode; title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <section className="module-header">
      <div className="module-header__icon">{icon}</div>
      <div className="module-header__info" style={{ flex: 1, minWidth: 0 }}>
        {subtitle && <p>{subtitle}</p>}
        <h2>{title}</h2>
      </div>
      {actions && <div className="module-header__actions">{actions}</div>}
    </section>
  );
}

const BIZ_TONE: Record<string, 'yellow' | 'blue' | 'green'> = { restaurant: 'yellow', fuel: 'blue', store: 'green' };
export function BizTag({ id }: { id: string }) {
  const { businessName } = useAuth();
  return <StatusBadge label={businessName(id)} tone={BIZ_TONE[id] ?? 'neutral'} />;
}

export function Money({ c, signed, strong }: { c: number | null | undefined; signed?: boolean; strong?: boolean }) {
  const v = c ?? 0;
  const color = signed ? (v < 0 ? '#b91c1c' : v > 0 ? '#15803d' : undefined) : v < 0 ? '#b91c1c' : undefined;
  return <span className="money" style={{ color, fontWeight: strong ? 700 : undefined }}>{signed && v > 0 ? '+' : ''}{money(v)}</span>;
}

export function MoneyInput({ value, onChange, id, placeholder = '0.00', autoFocus }: { value: string; onChange: (v: string) => void; id?: string; placeholder?: string; autoFocus?: boolean }) {
  return (
    <input id={id} className="form-input" inputMode="decimal" value={value} placeholder={placeholder} autoFocus={autoFocus}
      onFocus={(e) => e.target.select()} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))} />
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="form-field">
      <span className="form-field__label">{label}</span>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="mc-error">{error}</div> : null;
}

export function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const { today } = useAuth();
  const set = (days: number) => onChange(addDays(today, -days), today);
  return (
    <div className="toolbar">
      <input type="date" className="form-input date-input" value={from} max={to} onChange={(e) => onChange(e.target.value, to)} />
      <span>to</span>
      <input type="date" className="form-input date-input" value={to} max={today} onChange={(e) => onChange(from, e.target.value)} />
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => set(0)}>Today</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => set(6)}>7 days</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(today.slice(0, 8) + '01', today)}>This month</button>
    </div>
  );
}

/** One filter: a dropdown whose choices come from the rows on screen (e.g. "Recorded by"). */
export interface FilterDef<T> { key: string; label: string; get: (row: T) => string | null | undefined }

/**
 * Search and filters for a list already on screen: instant, no extra database reads.
 * `text` returns what the search box looks in; leave it out for no search box.
 */
export function useFilters<T>(rows: T[], defs: FilterDef<T>[], text?: (row: T) => string, placeholder = 'Search') {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Record<string, string>>({});
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!needle || !text || text(r).toLowerCase().includes(needle))
    && defs.every((d) => !sel[d.key] || (d.get(r) ?? '') === sel[d.key]));
  const active = Boolean(needle) || defs.some((d) => sel[d.key]);
  const bar = (
    <div className="filter-bar">
      {text && <input className="form-input filter-bar__search" type="search" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />}
      {defs.map((d) => {
        const options = [...new Set(rows.map((r) => d.get(r)).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b));
        if (options.length < 2 && !sel[d.key]) return null;
        return (
          <select key={d.key} className="form-select filter-bar__select" value={sel[d.key] ?? ''} onChange={(e) => setSel({ ...sel, [d.key]: e.target.value })} aria-label={d.label}>
            <option value="">{d.label}: all</option>
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        );
      })}
      {active && <>
        <span className="small muted">{shown.length} of {rows.length}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setSel({}); }}>Clear</button>
      </>}
    </div>
  );
  return { shown, bar, active };
}

export const addDays = (date: string, days: number) =>
  new Date(Date.parse(date + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);

/** Asks for a reason, then posts it (cancel sale, reopen day, …). */
export function ReasonModal({ open, title, message, action, confirmLabel = 'Confirm', onClose, onDone }: {
  open: boolean; title: string; message: ReactNode; action: string; confirmLabel?: string; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const { run, busy } = useSubmit();
  useEffect(() => { if (!open) setReason(''); }, [open]);
  const submit = async () => {
    const r = await run((key) => post(action, { reason }, key), 'Saved');
    if (r) { onClose(); onDone(); }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} width="sm"
      footer={<>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Back</button>
        <button type="button" className="btn btn-danger" disabled={busy || !reason.trim()} onClick={submit}>{confirmLabel}</button>
      </>}>
      <div className="form-stack">
        <div>{message}</div>
        <Field label="Reason (required)">
          <textarea className="form-textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
      </div>
    </Modal>
  );
}

export interface PayLine { method: string; amount: string }

/** Several payment methods for one transaction (e.g. part Cash, part Zaad). */
export function PaymentsEditor({ value, onChange, total, label = 'Payment' }: { value: PayLine[]; onChange: (v: PayLine[]) => void; total?: number; label?: string }) {
  const { activeMethods } = useAuth();
  const paid = value.reduce((s, p) => s + toCents(p.amount), 0);
  const set = (i: number, patchLine: Partial<PayLine>) => onChange(value.map((p, j) => (j === i ? { ...p, ...patchLine } : p)));
  return (
    <div className="pay-lines">
      {value.map((p, i) => (
        <div className="pay-line" key={i}>
          <select className="form-select" value={p.method} onChange={(e) => set(i, { method: e.target.value })} aria-label={`${label} method`}>
            {activeMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <MoneyInput value={p.amount} onChange={(v) => set(i, { amount: v })} />
          {value.length > 1 && <button type="button" className="btn btn-ghost btn-xs" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove">✕</button>}
        </div>
      ))}
      <div className="pay-actions">
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => onChange([...value, { method: activeMethods.find((m) => !value.some((v) => v.method === m.id))?.id ?? 'cash', amount: '' }])}>
          + Split payment
        </button>
        {total !== undefined && total > 0 && activeMethods.map((m) => (
          <button key={m.id} type="button" className="btn btn-ghost btn-xs" onClick={() => onChange([{ method: m.id, amount: fromCents(total) }])}>All {m.name}</button>
        ))}
        {total !== undefined && <span className="pay-sum">Paid {money(paid)}{total - paid > 0 ? ` · Unpaid ${money(total - paid)}` : ''}</span>}
      </div>
    </div>
  );
}

/** Pick from a list with type-to-search; optionally add a new one inline. */
export function PartySelect({ kind, value, onChange, items, onCreated, placeholder }: {
  kind: 'customers' | 'suppliers'; value: string; onChange: (id: string) => void; items: { id: string; name: string; phone?: string; balance?: number; active?: number }[];
  onCreated?: () => void; placeholder?: string;
}) {
  const { business } = useAuth();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const { run, busy } = useSubmit();
  const save = async () => {
    const r = await run((key) => post(`/${kind}`, { name, phone, business }, key), 'Added');
    if (r) { onCreated?.(); onChange(r.id); setAdding(false); setName(''); setPhone(''); }
  };
  if (adding) {
    return (
      <div className="pay-line">
        <input className="form-input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <input className="form-input" placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !name.trim()} onClick={save}>Add</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>✕</button>
      </div>
    );
  }
  return (
    <div className="pay-line">
      <select className="form-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder ?? (kind === 'customers' ? 'Walk-in customer' : 'No supplier')}</option>
        {items.filter((c) => c.active !== 0 || c.id === value).map((c) => (
          <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}{c.balance ? ` (${kind === 'customers' ? 'owes' : 'owed'} ${money(c.balance)})` : ''}</option>
        ))}
      </select>
      {onCreated && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>+ New</button>}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'red' | 'green' }) {
  return (
    <div className={`stat ${tone ? `stat--${tone}` : ''}`}>
      <span className="stat__label">{label}</span>
      <strong className="stat__value">{value}</strong>
      {sub && <span className="stat__sub">{sub}</span>}
    </div>
  );
}

export const fmtDate = (d: string) => new Date(d.length === 10 ? d + 'T12:00:00Z' : d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
export const fmtTime = (d: string) => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
