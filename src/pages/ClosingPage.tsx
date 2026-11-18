// Daily closing, made readable: first "the day in numbers", then one card per money
// account — what it started with, what came in, what went out, what it should have —
// and the person types what they counted. Any difference must be explained; it is
// recorded and shown to the owner. Closed days are locked (the owner/manager can reopen).
import { Fragment, useState } from 'react';
import { ClipboardCheck, Lock, Printer } from 'lucide-react';
import { get, money, num, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { PageSkeleton } from '../components/LoadingSpinner';
import { ErrorBox, Field, Kpi, MoneyInput, PageHeader, ReasonModal, fmtTime, useLoad, useSubmit } from '../components/ui';

/** Money that came in and went out of one account during the day (each part with its sign). */
function flows(l: any) {
  const parts: [string, number][] = [['Sales', l.sales_in], ['Debts collected', l.collections], ['Expenses paid', l.expenses_out], ['Suppliers & stock paid', l.suppliers_out], ['Transfers & owner money', l.transfers], ['Other', l.other]];
  const used = parts.filter(([, v]) => v !== 0);
  return { into: used.filter(([, v]) => v > 0), out: used.filter(([, v]) => v < 0), in: used.filter(([, v]) => v > 0).reduce((t, [, v]) => t + v, 0), outT: used.filter(([, v]) => v < 0).reduce((t, [, v]) => t + v, 0) };
}

/** One account's day: start + in − out = should have; counted; difference. */
function AccountCard({ l, counted, onCount, readOnly }: { l: any; counted?: string; onCount?: (v: string) => void; readOnly?: boolean }) {
  const f = flows(l);
  const has = readOnly ? l.counted : counted === undefined || counted === '' ? null : toCents(counted);
  const diff = has === null ? null : has - l.expected;
  return (
    <div className="closing-card">
      <div className="closing-card__head"><strong>{l.method_name}</strong>
        {diff !== null && (diff === 0 ? <StatusBadge label="Matches" tone="green" /> : <StatusBadge label={`${diff < 0 ? 'Short' : 'Over'} ${money(Math.abs(diff))}`} tone="red" />)}</div>
      <div className="kv">
        <span>Start of the day</span><span>{money(l.opening)}</span>
        <span>+ Came in</span><span style={{ color: '#15803d' }}>{money(f.in)}</span>
        {f.into.map(([k, v]) => <Fragment key={k}><span className="small closing-card__part">{k}</span><span className="small">{money(v)}</span></Fragment>)}
        <span>− Went out</span><span style={{ color: f.outT ? '#b91c1c' : undefined }}>{money(-f.outT)}</span>
        {f.out.map(([k, v]) => <Fragment key={k}><span className="small closing-card__part">{k}</span><span className="small">{money(-v)}</span></Fragment>)}
        <span className="kv-total">= Should have</span><span className="kv-total">{money(l.expected)}</span>
      </div>
      {readOnly ? (
        <div className="kv" style={{ marginTop: 8 }}><span className="kv-total">Counted</span><span className="kv-total">{money(l.counted)}</span></div>
      ) : (
        <Field label={l.method_id === 'cash' ? 'Cash you counted' : `${l.method_name} balance on the phone`}>
          <MoneyInput value={counted ?? ''} onChange={(v) => onCount?.(v)} placeholder={money(l.expected).replace('$', '')} />
        </Field>
      )}
    </div>
  );
}

export function ClosingPage() {
  const { business, businessName, today, can } = useAuth();
  const [date, setDate] = useState(today);
  const preview = useLoad(() => get('/closing/preview', { business, date }), [business, date]);
  const history = useLoad(() => get('/closing', { business }), [business]);
  // Counted amounts belong to one business and day; a new selection starts empty in the same render.
  const formKey = `${business}|${date}`;
  const [form, setForm] = useState({ key: formKey, counted: {} as Record<string, string>, explanation: '' });
  const current = form.key === formKey ? form : { key: formKey, counted: {} as Record<string, string>, explanation: '' };
  const { counted, explanation } = current;
  const [view, setView] = useState<any>(null);
  const [reopen, setReopen] = useState<any>(null);
  const { run, busy } = useSubmit();

  const p = preview.data;
  const lines = p?.lines ?? [];
  const diffs = lines.map((l: any) => (counted[l.method_id] === undefined || counted[l.method_id] === '' ? null : toCents(counted[l.method_id]) - l.expected));
  const allCounted = diffs.every((d: number | null) => d !== null);
  const anyDiff = diffs.some((d: number | null) => d);
  const totalDiff = diffs.reduce((s: number, d: number | null) => s + (d ?? 0), 0);
  const expected = lines.reduce((s: number, l: any) => s + l.expected, 0);
  const counting = lines.reduce((s: number, l: any) => s + (counted[l.method_id] ? toCents(counted[l.method_id]) : 0), 0);

  const close = async () => {
    const r = await run((key) => post('/closing', { business, date, explanation, counted: Object.fromEntries(lines.map((l: any) => [l.method_id, toCents(counted[l.method_id])])) }, key), `Day ${date} closed`);
    if (r) { preview.reload(); history.reload(); }
  };
  const latestClosed = (history.data ?? []).find((c: any) => c.business_id === business && c.status === 'closed');
  const expTotal = (p?.expenses ?? []).reduce((t: number, e: any) => t + e.total, 0);

  return (
    <div className="module-page">
      <PageHeader icon={<ClipboardCheck size={22} />} title={`Daily closing — ${businessName(business)}`}
        subtitle="See the day, count the money in each account, close the day"
        actions={<input type="date" className="form-input date-input" value={date} max={today} onChange={(e) => setDate(e.target.value)} aria-label="Day" />} />
      <ErrorBox error={preview.error} />
      {!p && !preview.error && <PageSkeleton />}
      {p && (
        <>
          {/* 1. The day in numbers */}
          <section className="kpi-grid">
            <Kpi label="Sales" value={money(p.sales.total)} sub={`${p.sales.count} sales${p.sales.returned ? ` · ${money(p.sales.returned)} returned` : ''}${p.sales.cancelled ? ` · ${p.sales.cancelled} cancelled` : ''}`} />
            <Kpi label="Given on credit" value={money(p.credit.given)} sub={`debts collected ${money(p.credit.collected)}`} />
            <Kpi label="Expenses" value={money(p.day.expenses)} sub={p.expenses.length ? p.expenses.slice(0, 2).map((e: any) => e.category).join(', ') + (p.expenses.length > 2 ? '…' : '') : 'none'} />
            <Kpi label="Purchases" value={money(p.purchases.total)} sub={p.purchases.count ? `${p.purchases.count} · ${money(p.purchases.owed)} owed` : 'none'} />
            <Kpi label="Profit of the day" value={money(p.day.profit)} tone={p.day.profit < 0 ? 'red' : 'green'} sub="sales − cost of goods − expenses" />
          </section>

          <div className="grid-2">
            <div className="panel">
              <div className="panel__header"><div><p>Sold today</p><h2>Top items</h2></div></div>
              <div className="kv">
                {p.topItems.map((i: any) => <Fragment key={i.name}><span>{num(i.qty)} × {i.name}</span><span>{money(i.amount)}</span></Fragment>)}
                {!p.topItems.length && <span className="muted">Nothing sold.</span>}
              </div>
            </div>
            <div className="panel">
              <div className="panel__header"><div><p>Spent today</p><h2>Expenses</h2></div></div>
              <div className="kv">
                {p.expenses.map((e: any) => <Fragment key={e.category}><span>{e.category}{e.count > 1 ? ` (${e.count})` : ''}</span><span>{money(e.total)}</span></Fragment>)}
                {p.expenses.length > 0 && <><span className="kv-total">Total</span><span className="kv-total">{money(expTotal)}</span></>}
                {!p.expenses.length && <span className="muted">No expenses.</span>}
              </div>
            </div>
          </div>

          {/* 2. Count the money */}
          <div className="panel">
            <div className="panel__header"><div><p>{p.locked ? 'Closed' : 'Count the money'}</p><h2>Money accounts</h2></div></div>
            {p.locked ? (
              <div className="mc-note row"><Lock size={16} /> {p.closing ? `This day was closed by ${p.closing.closed_by_name ?? ''} at ${fmtTime(p.closing.closed_at)}.` : `Closed up to ${p.lastClosed}. Earlier days are locked.`}
                {p.closing && <button type="button" className="btn btn-ghost btn-xs" onClick={async () => setView(await get(`/closing/${p.closing.id}`))}>View closing</button>}</div>
            ) : (
              <div className="form-stack">
                <div className="closing-cards">
                  {lines.map((l: any) => <AccountCard key={l.method_id} l={l} counted={counted[l.method_id]} onCount={(v) => setForm({ ...current, counted: { ...counted, [l.method_id]: v } })} />)}
                </div>
                <div className="closing-total">
                  <div className="kv">
                    <span>All accounts should have</span><span>{money(expected)}</span>
                    <span>You counted</span><span>{allCounted ? money(counting) : <span className="muted">count every account</span>}</span>
                    <span className="kv-total">Difference</span><span className="kv-total" style={{ color: allCounted && totalDiff ? '#b91c1c' : '#15803d' }}>{allCounted ? (totalDiff === 0 ? 'None ✓' : `${totalDiff < 0 ? 'Short' : 'Over'} ${money(Math.abs(totalDiff))}`) : '—'}</span>
                  </div>
                </div>
                {allCounted && anyDiff && <div className="mc-error">The counted money does not match. The difference is recorded and shown to the owner — explain it below.</div>}
                <Field label={anyDiff ? 'Explanation (required)' : 'Note (optional)'}>
                  <textarea className="form-textarea" rows={2} value={explanation} onChange={(e) => setForm({ ...current, explanation: e.target.value })} />
                </Field>
                <div className="form-actions">
                  <button type="button" className="btn btn-primary" style={{ minHeight: 48, minWidth: 220 }} disabled={busy || preview.stale || preview.loading || !allCounted || (anyDiff && !explanation.trim())} onClick={close}>
                    <Lock size={16} /> Close the day {date}
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* 3. Closed days */}
      <div className="panel">
        <div className="panel__header"><div><p>History</p><h2>Closed days</h2></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Day</th><th className="num">Should have</th><th className="num">Counted</th><th>Result</th><th>Closed by</th><th></th></tr></thead>
            <tbody>
              {(history.data ?? []).filter((c: any) => c.business_id === business).map((c: any) => (
                <tr key={c.id} className="tr--clickable" onClick={async () => setView(await get(`/closing/${c.id}`))}>
                  <td><strong>{c.entry_date}</strong>{c.status !== 'closed' && <div className="small muted">reopened by {c.reopened_by_name}: {c.reopen_reason}</div>}</td>
                  <td className="num">{money(c.total_expected)}</td><td className="num">{money(c.total_counted)}</td>
                  <td>{c.status !== 'closed' ? <StatusBadge label="Reopened" tone="yellow" /> : c.total_difference === 0 ? <StatusBadge label="Matched" tone="green" /> : <><StatusBadge label={`${c.total_difference < 0 ? 'Short' : 'Over'} ${money(Math.abs(c.total_difference))}`} tone="red" /><div className="small muted">{c.explanation}</div></>}</td>
                  <td className="small">{c.closed_by_name}<div className="muted">{fmtTime(c.closed_at)}</div></td>
                  <td onClick={(e) => e.stopPropagation()}>{can('void') && c.id === latestClosed?.id && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setReopen(c)}>Reopen</button>}</td>
                </tr>
              ))}
              {!history.loading && !(history.data ?? []).some((c: any) => c.business_id === business) && <tr><td colSpan={6} className="muted">No day closed yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={Boolean(view)} onClose={() => setView(null)} title={view ? `Closing ${view.entry_date}` : ''} width="lg"
        footer={<button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} /> Print</button>}>
        {view && (
          <div className="print-area form-stack">
            <img className="print-only print-logo" src="/logo-full.svg" alt="Meecaad" />
            <h3 style={{ margin: 0 }}>{view.business_name} — daily closing {view.entry_date}</h3>
            <div className="closing-cards">{view.lines.map((l: any) => <AccountCard key={l.id} l={l} readOnly />)}</div>
            <div className="kv">
              <span>Should have</span><span>{money(view.total_expected)}</span>
              <span>Counted</span><span>{money(view.total_counted)}</span>
              <span className="kv-total">Difference</span><span className="kv-total">{view.total_difference === 0 ? 'None' : money(view.total_difference)}</span>
            </div>
            {view.explanation && <p style={{ margin: 0 }}><strong>Explanation:</strong> {view.explanation}</p>}
            <p className="small muted" style={{ margin: 0 }}>Closed by {view.closed_by_name} at {fmtTime(view.closed_at)}{view.status === 'reopened' ? ` · Reopened by ${view.reopened_by_name}: ${view.reopen_reason}` : ''}</p>
          </div>
        )}
      </Modal>
      {reopen && <ReasonModal open onClose={() => setReopen(null)} title={`Reopen ${reopen.entry_date}?`} action={`/closing/${reopen.id}/reopen`} confirmLabel="Reopen day"
        message="The day becomes editable again and its cash difference is reversed. It must be closed again after corrections. The reopening is recorded."
        onDone={() => { preview.reload(); history.reload(); }} />}
    </div>
  );
}
