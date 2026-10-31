import { useEffect, useState } from 'react';
import { ClipboardCheck, Lock, Printer } from 'lucide-react';
import { get, money, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { BizTag, ErrorBox, Field, Money, MoneyInput, PageHeader, ReasonModal, Stat, fmtTime, useLoad, useSubmit } from '../components/ui';

const COLS: [string, string][] = [
  ['opening', 'Opening'], ['sales_in', 'Sales'], ['collections', 'Debts collected'], ['expenses_out', 'Expenses paid'],
  ['suppliers_out', 'Stock & suppliers paid'], ['transfers', 'Transfers & owner'], ['other', 'Other'],
];

export function ClosingPage() {
  const { business, businessName, today, can } = useAuth();
  const [date, setDate] = useState(today);
  const preview = useLoad(() => get('/closing/preview', { business, date }), [business, date]);
  const history = useLoad(() => get('/closing', { business: can('reports') ? 'all' : business }), [business]);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [explanation, setExplanation] = useState('');
  const [view, setView] = useState<any>(null);
  const [reopen, setReopen] = useState<any>(null);
  const { run, busy } = useSubmit();

  useEffect(() => { setCounted({}); setExplanation(''); }, [business, date]);

  const p = preview.data;
  const lines = p?.lines ?? [];
  // Only show the kinds of movement that happened, so the table stays narrow on small screens.
  const cols = COLS.filter(([k]) => k === 'opening' || lines.some((l: any) => l[k] !== 0));
  const diffs = lines.map((l: any) => (counted[l.method_id] === undefined || counted[l.method_id] === '' ? null : toCents(counted[l.method_id]) - l.expected));
  const allCounted = diffs.every((d: number | null) => d !== null);
  const anyDiff = diffs.some((d: number | null) => d);
  const totalDiff = diffs.reduce((s: number, d: number | null) => s + (d ?? 0), 0);

  const close = async () => {
    const r = await run((key) => post('/closing', {
      business, date, explanation, counted: Object.fromEntries(lines.map((l: any) => [l.method_id, toCents(counted[l.method_id])])),
    }, key), 'Day closed');
    if (r) { preview.reload(); history.reload(); }
  };
  const latestClosed = (history.data ?? []).find((c: any) => c.business_id === business && c.status === 'closed');

  return (
    <div className="module-page">
      <PageHeader icon={<ClipboardCheck size={22} />} title={`Daily cash closing — ${businessName(business)}`}
        subtitle="Count the money at the end of the day. The system shows what should be there."
        actions={<input type="date" className="form-input date-input" value={date} max={today} onChange={(e) => setDate(e.target.value)} />} />
      <ErrorBox error={preview.error} />
      {p && (
        <>
          <section className="stat-grid">
            <Stat label="Sales today" value={money(p.day.revenue)} sub={`of which on credit ${money(p.credit.given)}`} />
            <Stat label="Debts collected" value={money(p.credit.collected)} />
            <Stat label="Expenses" value={money(p.day.expenses)} />
            <Stat label="Expected money (all accounts)" value={money(lines.reduce((s: number, l: any) => s + l.expected, 0))} />
          </section>

          <div className="panel">
            {p.locked ? (
              <div className="mc-note row"><Lock size={16} /> {p.closing ? `This day was closed by ${p.closing.closed_by_name ?? ''} at ${fmtTime(p.closing.closed_at)}.` : `Closed up to ${p.lastClosed}. Earlier days are locked.`}
                {p.closing && <button type="button" className="btn btn-ghost btn-xs" onClick={async () => setView(await get(`/closing/${p.closing.id}`))}>View closing</button>}</div>
            ) : (
              <div className="form-stack">
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Account</th>{cols.map(([k, l]) => <th key={k} className="num">{l}</th>)}<th className="num">Expected</th><th>Counted</th><th className="num">Difference</th></tr></thead>
                    <tbody>
                      {lines.map((l: any, i: number) => (
                        <tr key={l.method_id}>
                          <td style={{ position: 'sticky', left: 0, background: '#fff' }}><strong>{l.method_name}</strong></td>
                          {cols.map(([k]) => <td key={k} className="num"><Money c={l[k]} signed={k !== 'opening'} /></td>)}
                          <td className="num"><Money c={l.expected} strong /></td>
                          <td style={{ minWidth: 120 }}><MoneyInput value={counted[l.method_id] ?? ''} onChange={(v) => setCounted({ ...counted, [l.method_id]: v })} placeholder={l.method_id === 'cash' ? 'Count cash' : 'Check balance'} /></td>
                          <td className="num">{diffs[i] === null ? '—' : <Money c={diffs[i]} signed strong />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="small muted">Cash: count the notes in the drawer. Zaad / Edahab: check the business account balance on the phone.</p>
                {allCounted && (anyDiff ? (
                  <div className="mc-error">Difference of {money(Math.abs(totalDiff))} ({totalDiff < 0 ? 'missing' : 'extra'}). It will be recorded as a cash difference and shown to the owner. Explain it below.</div>
                ) : <div className="mc-note">Everything matches.</div>)}
                <Field label={anyDiff ? 'Explanation (required)' : 'Note (optional)'}>
                  <textarea className="form-textarea" rows={2} value={explanation} onChange={(e) => setExplanation(e.target.value)} />
                </Field>
                <div className="form-actions">
                  <button type="button" className="btn btn-primary" disabled={busy || !allCounted || (anyDiff && !explanation.trim())} onClick={close}>Close the day {date}</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <div className="panel">
        <div className="panel__header"><div><p>History</p><h2>Closed days</h2></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Business</th><th className="num">Expected</th><th className="num">Counted</th><th className="num">Difference</th><th>Explanation</th><th>Closed by</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(history.data ?? []).map((c: any) => (
                <tr key={c.id} className="tr--clickable" onClick={async () => setView(await get(`/closing/${c.id}`))}>
                  <td>{c.entry_date}</td><td><BizTag id={c.business_id} /></td>
                  <td className="num">{money(c.total_expected)}</td><td className="num">{money(c.total_counted)}</td>
                  <td className="num"><Money c={c.total_difference} signed strong /></td>
                  <td className="small">{c.explanation}</td>
                  <td className="small">{c.closed_by_name}<div className="muted">{fmtTime(c.closed_at)}</div></td>
                  <td>{c.status === 'closed' ? <StatusBadge label="Closed" tone="green" /> : <><StatusBadge label="Reopened" tone="yellow" /><div className="small muted">{c.reopened_by_name}: {c.reopen_reason}</div></>}</td>
                  <td onClick={(e) => e.stopPropagation()}>{can('void') && c.id === latestClosed?.id && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setReopen(c)}>Reopen</button>}</td>
                </tr>
              ))}
              {!history.loading && !history.data?.length && <tr><td colSpan={9} className="muted">No days closed yet.</td></tr>}
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
            <table>
              <thead><tr><th>Account</th>{COLS.map(([k, l]) => <th key={k} className="num">{l}</th>)}<th className="num">Expected</th><th className="num">Counted</th><th className="num">Difference</th></tr></thead>
              <tbody>{view.lines.map((l: any) => (
                <tr key={l.id}><td>{l.method_name}</td>{COLS.map(([k]) => <td key={k} className="num">{money(l[k])}</td>)}
                  <td className="num">{money(l.expected)}</td><td className="num">{money(l.counted)}</td><td className="num"><Money c={l.difference} signed /></td></tr>
              ))}</tbody>
            </table>
            {view.explanation && <p><strong>Explanation:</strong> {view.explanation}</p>}
            <p className="small muted">Closed by {view.closed_by_name} at {fmtTime(view.closed_at)}{view.status === 'reopened' ? ` · Reopened by ${view.reopened_by_name}: ${view.reopen_reason}` : ''}</p>
          </div>
        )}
      </Modal>
      {reopen && <ReasonModal open onClose={() => setReopen(null)} title={`Reopen ${reopen.entry_date}?`} action={`/closing/${reopen.id}/reopen`} confirmLabel="Reopen day"
        message="The day becomes editable again and its cash difference is reversed. It must be closed again after corrections. The reopening is recorded."
        onDone={() => { preview.reload(); history.reload(); }} />}
    </div>
  );
}
