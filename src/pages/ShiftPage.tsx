// Restaurant shift closing (xisaab xidh).
//   Close My Shift — each person who takes money counts it and hands it over.
//   Closings       — owner/manager: every shift, open shifts, days, cashiers, month/year locks.
import { useState } from 'react';
import { CalendarCheck, ClipboardCheck, Lock, Printer, Unlock, Wallet } from 'lucide-react';
import { get, money, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { PageSkeleton } from '../components/LoadingSpinner';
import { DateRange, ErrorBox, Field, Money, MoneyInput, PageHeader, ReasonModal, Stat, fmtTime, useFilters, useLoad, useSubmit } from '../components/ui';

const R = 'restaurant';
const COLS: [string, string][] = [['sales_in', 'Sales'], ['collections', 'Debts collected'], ['expenses_out', 'Expenses paid'], ['other', 'Other']];
/** Business day (East Africa Time, UTC+3) of a stored UTC moment. */
const fmtDay = (ts: string) => (ts ? new Date(Date.parse(ts) + 3 * 3600_000).toISOString().slice(0, 10) : '');

// ── Close My Shift ──────────────────────────────────────────────
export function ShiftPage() {
  const { user } = useAuth();
  const s = useLoad(() => get('/shifts/mine', { business: R }), []);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [float, setFloat] = useState('');
  const [explanation, setExplanation] = useState('');
  const [handedTo, setHandedTo] = useState('');
  const [slip, setSlip] = useState<any>(null);
  const { run, busy } = useSubmit();

  const d = s.data;
  const lines = d?.lines ?? [];
  const floatC = toCents(float || '0');
  const expectedOf = (l: any) => l.expected + (l.method_id === 'cash' ? floatC : 0);
  const cols = COLS.filter(([k]) => lines.some((l: any) => l[k] !== 0));
  // A method nobody used (nothing expected) counts as 0 unless something is typed.
  const unused = (l: any) => !l.used && expectedOf(l) === 0;
  const countOf = (l: any) => (counted[l.method_id] === undefined || counted[l.method_id] === '' ? (unused(l) ? 0 : null) : toCents(counted[l.method_id]));
  const diffs = lines.map((l: any) => { const c = countOf(l); return c === null ? null : c - expectedOf(l); });
  const allCounted = diffs.every((x: number | null) => x !== null);
  const anyDiff = diffs.some((x: number | null) => x);
  const totalDiff = diffs.reduce((t: number, x: number | null) => t + (x ?? 0), 0);
  const expected = lines.reduce((t: number, l: any) => t + expectedOf(l), 0);
  const receiver = handedTo || (d?.receivers?.length === 1 ? d.receivers[0].id : '');

  const close = async () => {
    const r = await run((key) => post('/shifts/close', {
      business: R, startFloat: floatC, explanation, handedTo: receiver,
      counted: Object.fromEntries(lines.map((l: any) => [l.method_id, countOf(l)])),
    }, key), 'Shift closed');
    if (r) {
      setCounted({}); setFloat(''); setExplanation('');
      setSlip(await get(`/shifts/${r.id}`));
      s.reload();
    }
  };

  return (
    <div className="module-page">
      <PageHeader icon={<Wallet size={22} />} title="Close my shift" subtitle={`${user?.full_name} · count the money you took and hand it over`} />
      <ErrorBox error={s.error} />
      {!d && !s.error && <PageSkeleton />}
      {d?.owner && <div className="panel"><p className="muted">The owner does not close shifts. Your money is not drawer money. See every person's shift under Closings.</p></div>}
      {d && !d.owner && (d.activity ? (
        <>
          {d.mustClose && <div className="mc-error">Your shift from {d.firstDate} is still open. Close it now — you cannot take payments or pay expenses until it is closed.</div>}
          <section className="stat-grid">
            <Stat label="Shift started" value={d.firstDate ?? '—'} sub={d.recent?.some((c: any) => c.status === 'closed') ? `after your last closing ${fmtTime(d.from)}` : 'your first shift'} />
            <Stat label="Paid orders" value={String(d.sales.count)} sub={`sales ${money(d.sales.total)}${d.sales.credit ? ` · on credit ${money(d.sales.credit)}` : ''}`} />
            <Stat label="Expenses you paid" value={money(d.expenses)} />
            <Stat label="You should have" value={money(expected)} sub="all payment methods together" />
          </section>

          <div className="panel form-stack">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Payment method</th>{cols.map(([k, l]) => <th key={k} className="num">{l}</th>)}<th className="num">Expected</th><th>You have</th><th className="num">Difference</th></tr></thead>
                <tbody>
                  {lines.map((l: any, i: number) => (
                    <tr key={l.method_id}>
                      <td><strong>{l.method_name}</strong></td>
                      {cols.map(([k]) => <td key={k} className="num"><Money c={l[k]} signed /></td>)}
                      <td className="num"><Money c={expectedOf(l)} strong /></td>
                      <td style={{ minWidth: 120 }}><MoneyInput value={counted[l.method_id] ?? ''} onChange={(v) => setCounted({ ...counted, [l.method_id]: v })} placeholder={unused(l) ? '0.00' : l.method_id === 'cash' ? 'Count cash' : 'Check phone'} /></td>
                      <td className="num">{diffs[i] === null ? '—' : <Money c={diffs[i]} signed strong />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">Cash: count the notes you have. Zaad / Edahab: the payments you received on the business phone during your shift.</p>
            <Field label="Change money that was already in the drawer when you started (optional)">
              <MoneyInput value={float} onChange={setFloat} placeholder="0.00" />
            </Field>
            {d.unpaid.count > 0 && (
              <div className="mc-note">{d.unpaid.count} unpaid {d.unpaid.count === 1 ? 'order' : 'orders'} ({money(d.unpaid.total)}) {d.unpaid.count === 1 ? 'stays' : 'stay'} open and are handed over to the next shift. Not part of your money.</div>
            )}
            {allCounted && (anyDiff ? (
              <div className="mc-error">{money(Math.abs(totalDiff))} {totalDiff < 0 ? 'missing' : 'extra'}. It is recorded under your name and shown to the owner. Explain it below.</div>
            ) : <div className="mc-note">Everything matches.</div>)}
            <Field label="Hand the money to">
              <select className="form-select" value={receiver} onChange={(e) => setHandedTo(e.target.value)}>
                <option value="">Choose…</option>
                {d.receivers.map((p: any) => <option key={p.id} value={p.id}>{p.full_name} ({p.role})</option>)}
              </select>
            </Field>
            <Field label={anyDiff ? 'Explanation (required)' : 'Note (optional)'}>
              <textarea className="form-textarea" rows={2} value={explanation} onChange={(e) => setExplanation(e.target.value)} />
            </Field>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" disabled={busy || !s.fresh || !allCounted || !receiver || (anyDiff && !explanation.trim())} onClick={close}>
                <ClipboardCheck size={16} /> Close my shift
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="panel"><p className="muted">Nothing to close. You have not taken or paid out any money since your last closing.</p></div>
      ))}

      {d?.recent?.length > 0 && (
        <div className="panel">
          <div className="panel__header"><div><p>History</p><h2>My closings</h2></div></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Closed</th><th className="num">Sales</th><th className="num">Expected</th><th className="num">Handed over</th><th className="num">Difference</th><th>To</th><th>Status</th></tr></thead>
              <tbody>
                {d.recent.map((c: any) => (
                  <tr key={c.id} className="tr--clickable" onClick={async () => setSlip(await get(`/shifts/${c.id}`))}>
                    <td>{fmtTime(c.closed_at)}</td><td className="num">{money(c.sales_total)}</td><td className="num">{money(c.total_expected)}</td>
                    <td className="num">{money(c.total_counted)}</td><td className="num"><Money c={c.total_difference} signed strong /></td><td>{c.handed_to_name}</td>
                    <td>{c.status === 'closed' ? <StatusBadge label="Closed" tone="green" /> : <StatusBadge label="Reopened" tone="yellow" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <ShiftSlip slip={slip} onClose={() => setSlip(null)} />
    </div>
  );
}

/** The printable shift slip: what was expected, what was handed over, to whom. */
function ShiftSlip({ slip, onClose }: { slip: any; onClose: () => void }) {
  return (
    <Modal open={Boolean(slip)} onClose={onClose} title={slip ? `Shift closing — ${slip.user_name}` : ''} width="lg"
      footer={<button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print slip</button>}>
      {slip && (
        <div className="print-area form-stack">
          <img className="print-only print-logo" src="/logo-full.svg" alt="Meecaad" />
          <h3 style={{ margin: 0 }}>{slip.business_name} — shift closing</h3>
          <p className="small" style={{ margin: 0 }}>
            <strong>{slip.user_name}</strong> · from {slip.first_date ?? fmtDay(slip.from_ts)} to {fmtTime(slip.closed_at)}<br />
            Paid orders: {slip.sales_count} ({money(slip.sales_total)}){slip.credit_total ? ` · on credit ${money(slip.credit_total)}` : ''} · Expenses paid: {money(slip.expenses_total)}
            {slip.start_float ? <> · Change money at start: {money(slip.start_float)}</> : null}
          </p>
          <table>
            <thead><tr><th>Method</th>{COLS.map(([k, l]) => <th key={k} className="num">{l}</th>)}<th className="num">Expected</th><th className="num">Handed over</th><th className="num">Difference</th></tr></thead>
            <tbody>
              {slip.lines.map((l: any) => (
                <tr key={l.id}><td>{l.method_name}</td>{COLS.map(([k]) => <td key={k} className="num">{money(l[k])}</td>)}
                  <td className="num">{money(l.expected)}</td><td className="num">{money(l.counted)}</td><td className="num"><Money c={l.difference} signed /></td></tr>
              ))}
              <tr><td><strong>Total</strong></td>{COLS.map(([k]) => <td key={k} />)}<td className="num"><strong>{money(slip.total_expected)}</strong></td>
                <td className="num"><strong>{money(slip.total_counted)}</strong></td><td className="num"><Money c={slip.total_difference} signed strong /></td></tr>
            </tbody>
          </table>
          {slip.explanation && <p style={{ margin: 0 }}><strong>Explanation:</strong> {slip.explanation}</p>}
          {slip.unpaid_orders > 0 && <p className="small" style={{ margin: 0 }}>Handed over to the next shift: {slip.unpaid_orders} unpaid {slip.unpaid_orders === 1 ? 'order' : 'orders'} ({money(slip.unpaid_total)}).</p>}
          <p style={{ margin: 0 }}>Money handed to: <strong>{slip.handed_to_name}</strong></p>
          {slip.status === 'reopened' && <div className="mc-error">Reopened by {slip.reopened_by_name} ({fmtTime(slip.reopened_at)}): {slip.reopen_reason}</div>}
          <div className="print-only" style={{ display: 'flex', gap: 48, marginTop: 32 }}>
            <span>Cashier: ____________________</span><span>Received by: ____________________</span>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Closings (owner / manager) ─────────────────────────────────
const TABS = [['shifts', 'Shifts'], ['open', 'Not closed yet'], ['days', 'Days'], ['cashiers', 'Cashiers'], ['periods', 'Months & years']] as const;

export function ClosingsPage() {
  const { today } = useAuth();
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('shifts');
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  return (
    <div className="module-page">
      <PageHeader icon={<CalendarCheck size={22} />} title="Closings" subtitle="Every shift closing, who handed over what, and month / year closing" />
      <div className="scope-tabs">
        {TABS.map(([k, l]) => <button key={k} type="button" className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {['shifts', 'days', 'cashiers'].includes(tab) && <DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} />}
      {tab === 'shifts' && <ShiftsTab from={from} to={to} />}
      {tab === 'open' && <OpenTab />}
      {(tab === 'days' || tab === 'cashiers') && <SummaryTab from={from} to={to} view={tab} />}
      {tab === 'periods' && <PeriodsTab />}
    </div>
  );
}

function ShiftsTab({ from, to }: { from: string; to: string }) {
  const { can } = useAuth();
  const list = useLoad(() => get('/shifts', { business: R, from, to }), [from, to]);
  const filter = useFilters<any>(list.data ?? [], [
    { key: 'person', label: 'Person', get: (c) => c.user_name },
    { key: 'to', label: 'Handed to', get: (c) => c.handed_to_name },
    { key: 'diff', label: 'Result', get: (c) => (c.total_difference < 0 ? 'Short' : c.total_difference > 0 ? 'Over' : 'Exact') },
    { key: 'status', label: 'Status', get: (c) => (c.status === 'closed' ? 'Closed' : 'Reopened') },
  ]);
  const [slip, setSlip] = useState<any>(null);
  const [reopen, setReopen] = useState<any>(null);
  return (
    <div className="panel">
      <ErrorBox error={list.error} />
      {filter.bar}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Closed</th><th>Person</th><th className="num">Sales</th><th className="num">Expenses</th><th className="num">Expected</th><th className="num">Handed over</th><th className="num">Difference</th><th>Handed to</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {filter.shown.map((c: any) => (
              <tr key={c.id} className="tr--clickable" onClick={async () => setSlip(await get(`/shifts/${c.id}`))}>
                <td>{fmtTime(c.closed_at)}<div className="small muted">{fmtDay(c.closed_at)}</div></td>
                <td><strong>{c.user_name}</strong></td>
                <td className="num">{money(c.sales_total)}</td><td className="num">{money(c.expenses_total)}</td>
                <td className="num">{money(c.total_expected)}</td><td className="num">{money(c.total_counted)}</td>
                <td className="num"><Money c={c.total_difference} signed strong />{c.explanation && <div className="small muted" style={{ maxWidth: 220, whiteSpace: 'normal' }}>{c.explanation}</div>}</td>
                <td>{c.handed_to_name}</td>
                <td>{c.status === 'closed' ? <StatusBadge label="Closed" tone="green" /> : <><StatusBadge label="Reopened" tone="yellow" /><div className="small muted">{c.reopened_by_name}: {c.reopen_reason}</div></>}</td>
                <td onClick={(e) => e.stopPropagation()}>{can('void') && c.status === 'closed' && Boolean(c.is_latest) && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setReopen(c)}>Reopen</button>}</td>
              </tr>
            ))}
            {!list.loading && !filter.shown.length && <tr><td colSpan={10} className="muted">{filter.active ? 'Nothing matches.' : 'No shifts closed in this period.'}</td></tr>}
          </tbody>
        </table>
      </div>
      <ShiftSlip slip={slip} onClose={() => setSlip(null)} />
      {reopen && <ReasonModal open onClose={() => setReopen(null)} title={`Reopen ${reopen.user_name}'s shift?`} action={`/shifts/${reopen.id}/reopen`} confirmLabel="Reopen shift"
        message="The shift goes back to open and its cash difference is reversed. The person must close it again. The reopening is recorded."
        onDone={() => list.reload()} />}
    </div>
  );
}

function OpenTab() {
  const { today } = useAuth();
  const list = useLoad(() => get('/shifts/open', { business: R }), []);
  return (
    <div className="panel">
      <p className="small muted">People holding money they have not closed yet. Anyone with money from an earlier day is blocked until they close.</p>
      <ErrorBox error={list.error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Person</th><th>Since</th><th className="num">Paid orders</th><th className="num">Sales</th><th className="num">Should have</th></tr></thead>
          <tbody>
            {(list.data ?? []).map((o: any) => (
              <tr key={o.user_id}><td><strong>{o.user_name}</strong></td>
                <td>{o.since}{o.since < today && <> <StatusBadge label="Earlier day" tone="red" /></>}</td>
                <td className="num">{o.sales.count}</td><td className="num">{money(o.sales.total)}</td><td className="num"><strong>{money(o.expected)}</strong></td></tr>
            ))}
            {!list.loading && !list.data?.length && <tr><td colSpan={5} className="muted">Everyone has closed their shift.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryTab({ from, to, view }: { from: string; to: string; view: 'days' | 'cashiers' }) {
  const r = useLoad(() => get('/shifts/summary', { business: R, from, to }), [from, to]);
  const s = r.data;
  return (
    <div className="panel">
      <ErrorBox error={r.error} />
      {s && view === 'days' && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Day</th><th className="num">Shifts closed</th><th className="num">Sales</th><th className="num">Difference</th></tr></thead>
            <tbody>
              {s.days.map((x: any) => <tr key={x.day}><td>{x.day}</td><td className="num">{x.shifts}</td><td className="num">{money(x.sales)}</td><td className="num"><Money c={x.difference} signed strong /></td></tr>)}
              {!s.days.length && <tr><td colSpan={4} className="muted">No shifts closed in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {s && view === 'cashiers' && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Person</th><th className="num">Shifts</th><th className="num">Sales</th><th className="num">Expenses paid</th><th className="num">Short</th><th className="num">Over</th><th className="num">Net difference</th></tr></thead>
            <tbody>
              {s.cashiers.map((x: any) => (
                <tr key={x.user_id}><td><strong>{x.user_name}</strong></td><td className="num">{x.shifts}</td><td className="num">{money(x.sales)}</td><td className="num">{money(x.expenses)}</td>
                  <td className="num" style={{ color: x.short ? '#b91c1c' : undefined }}>{money(-x.short)}</td><td className="num">{money(x.over)}</td><td className="num"><Money c={x.difference} signed strong /></td></tr>
              ))}
              {!s.cashiers.length && <tr><td colSpan={7} className="muted">No shifts closed in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PeriodsTab() {
  const { user, today } = useAuth();
  const locks = useLoad(() => get('/period-locks', { business: R }), []);
  const lastMonth = (() => { const [y, m] = today.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
  const [kind, setKind] = useState<'month' | 'year'>('month');
  const [month, setMonth] = useState(lastMonth);
  const [year, setYear] = useState(String(Number(today.slice(0, 4)) - 1));
  const [unlock, setUnlock] = useState<any>(null);
  const { run, busy } = useSubmit();
  const period = kind === 'month' ? month : year;
  const lock = async () => {
    const r = await run((key) => post('/period-locks', { business: R, period }, key), `${period} closed`);
    if (r) locks.reload();
  };
  return (
    <div className="form-stack">
      {user?.owner && (
        <div className="panel form-stack">
          <p className="small muted">Closing a finished month or year locks it: nothing dated in it can be added, changed or cancelled anymore. All shifts with money in it must be closed first. You can reopen it with a reason.</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Close a">
              <select className="form-select" value={kind} onChange={(e) => setKind(e.target.value as 'month' | 'year')}><option value="month">Month</option><option value="year">Year</option></select>
            </Field>
            {kind === 'month'
              ? <Field label="Month"><input type="month" className="form-input" value={month} max={lastMonth} onChange={(e) => setMonth(e.target.value)} /></Field>
              : <Field label="Year"><input type="number" className="form-input" value={year} max={Number(today.slice(0, 4)) - 1} onChange={(e) => setYear(e.target.value)} /></Field>}
            <button type="button" className="btn btn-primary" disabled={busy || !period} onClick={lock}><Lock size={16} /> Close {period}</button>
          </div>
        </div>
      )}
      <div className="panel">
        <ErrorBox error={locks.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Period</th><th>Locked up to</th><th>Closed by</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(locks.data ?? []).map((l: any) => (
                <tr key={l.id}><td><strong>{l.period}</strong> <span className="small muted">({l.kind})</span></td><td>{l.locked_until}</td>
                  <td className="small">{l.locked_by_name}<div className="muted">{fmtTime(l.locked_at)}</div></td>
                  <td>{l.status === 'locked' ? <StatusBadge label="Closed" tone="green" /> : <><StatusBadge label="Reopened" tone="yellow" /><div className="small muted">{l.unlocked_by_name}: {l.unlock_reason}</div></>}</td>
                  <td>{user?.owner && l.status === 'locked' && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setUnlock(l)}><Unlock size={14} /> Reopen</button>}</td></tr>
              ))}
              {!locks.loading && !locks.data?.length && <tr><td colSpan={5} className="muted">No month or year closed yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {unlock && <ReasonModal open onClose={() => setUnlock(null)} title={`Reopen ${unlock.period}?`} action={`/period-locks/${unlock.id}/unlock`} confirmLabel="Reopen"
        message="Records dated in this period can be changed again. The reopening is recorded." onDone={() => locks.reload()} />}
    </div>
  );
}
