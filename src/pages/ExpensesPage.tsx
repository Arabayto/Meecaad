import { Fragment, useState } from 'react';
import { Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { get, money, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../components/StatusBadge';
import { DateRange, ErrorBox, Money, MoneyInput, PageHeader, PartySelect, ReasonModal, addDays, useLoad, useSubmit } from '../components/ui';

interface Row { category: string; description: string; amount: string; method: string; supplier: string }

const CATEGORIES = ['Salaries', 'Rent', 'Electricity', 'Water', 'Generator fuel', 'Transport', 'Repairs', 'Gas / cooking fuel', 'Cleaning', 'Phone & internet', 'Taxes & licences', 'Other'];

export function ExpensesPage() {
  const { business, businessName, today, can, activeMethods } = useAuth();
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const list = useLoad(() => get('/expenses', { business, from, to }), [business, from, to]);
  // The restaurant records expenses when they are paid (it has no suppliers).
  const owedAllowed = business !== 'restaurant';
  const suppliers = useLoad(() => (owedAllowed ? get('/suppliers', { business }) : Promise.resolve([])), [business]);
  // Several expenses at once: one row each; empty rows are ignored; all are saved together.
  const blank = (method = 'cash'): Row => ({ category: '', description: '', amount: '', method, supplier: '' });
  const [lines, setLines] = useState<Row[]>([blank(), blank()]);
  const [date, setDate] = useState(today);
  const [voiding, setVoiding] = useState<any>(null);
  const { run, busy } = useSubmit();
  const setLine = (i: number, patch: Partial<Row>) => setLines((l) => l.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const filled = lines.filter((r) => r.category.trim() || r.amount);
  const problem = filled.find((r) => !r.category.trim() || toCents(r.amount) <= 0 || (r.method === 'unpaid' && !r.supplier));
  const newTotal = filled.reduce((s, r) => s + toCents(r.amount), 0);

  const save = async () => {
    const r = await run((key) => post('/expenses/batch', {
      business, date,
      items: filled.map((x) => ({
        category: x.category, description: x.description, amount: toCents(x.amount),
        method: x.method === 'unpaid' ? undefined : x.method, supplier: x.method === 'unpaid' ? x.supplier : undefined,
      })),
    }, key), filled.length === 1 ? 'Expense saved' : `${filled.length} expenses saved`);
    if (r) { setLines([blank(lines[0]?.method), blank(lines[0]?.method)]); list.reload(); }
  };

  const rows = (list.data ?? []).filter((e: any) => e.status === 'completed');
  const byCat = Object.entries(rows.reduce((acc: Record<string, number>, e: any) => ({ ...acc, [e.category]: (acc[e.category] ?? 0) + e.amount }), {}))
    .sort((a, b) => (b[1] as number) - (a[1] as number));
  const total = rows.reduce((s: number, e: any) => s + e.amount, 0);

  return (
    <div className="module-page">
      <PageHeader icon={<ShoppingBag size={22} />} title={`Expenses — ${businessName(business)}`} subtitle="Running costs of the business (not stock for sale)" />
      <div className="panel">
        <div className="panel__header">
          <div><p>New</p><h2>Record expenses</h2></div>
          <input type="date" className="form-input date-input" value={date} max={today} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
        </div>
        <datalist id="expense-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
        <div className="table-wrap lines-table">
          <table>
            <thead><tr><th>Category</th><th>Details (optional)</th><th>Amount</th><th>Paid with</th><th></th></tr></thead>
            <tbody>
              {lines.map((r, i) => (
                <tr key={i}>
                  <td><input className="form-input" list="expense-categories" value={r.category} onChange={(e) => setLine(i, { category: e.target.value })} placeholder="Choose or type" /></td>
                  <td><input className="form-input" value={r.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="e.g. salary – Ali" /></td>
                  <td style={{ minWidth: 110 }}><MoneyInput value={r.amount} onChange={(v) => setLine(i, { amount: v })} /></td>
                  <td style={{ minWidth: 150 }}>
                    <select className="form-select" value={r.method} onChange={(e) => setLine(i, { method: e.target.value })}>
                      {activeMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      {owedAllowed && <option value="unpaid">Not paid yet (owed)</option>}
                    </select>
                    {r.method === 'unpaid' && <div style={{ marginTop: 6 }}><PartySelect kind="suppliers" value={r.supplier} onChange={(v) => setLine(i, { supplier: v })} items={suppliers.data ?? []} onCreated={suppliers.reload} placeholder="Owed to…" /></div>}
                  </td>
                  <td>{lines.length > 1 && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove row"><Trash2 size={14} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row row--between" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLines([...lines, blank(lines[lines.length - 1]?.method)])}><Plus size={14} /> Add row</button>
          <div className="row">
            {problem && <span className="small" style={{ color: '#b91c1c' }}>Each row needs a category and an amount{owedAllowed ? ' (and who it is owed to)' : ''}.</span>}
            <strong>{money(newTotal)}</strong>
            <button type="button" className="btn btn-primary" disabled={busy || !filled.length || Boolean(problem)} onClick={save}>
              {filled.length > 1 ? `Save ${filled.length} expenses` : 'Save expense'}
            </button>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel__header"><div><p>This period</p><h2>{money(total)} spent</h2></div></div>
        <div className="kv" style={{ maxWidth: 480 }}>
          {byCat.map(([c, v]) => <Fragment key={c}><span>{c}</span><span>{money(v as number)}</span></Fragment>)}
          {!byCat.length && <span className="muted">No expenses yet.</span>}
        </div>
      </div>

      <div className="panel">
        <div className="panel__header"><div><p>History</p><h2>Expenses</h2></div><DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} /></div>
        <ErrorBox error={list.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Category</th><th>Details</th><th className="num">Amount</th><th>Paid with</th><th>Status</th><th>By</th><th></th></tr></thead>
            <tbody>
              {(list.data ?? []).map((e: any) => (
                <tr key={e.id}>
                  <td className="small">{e.entry_date}</td>
                  <td>{e.category}</td>
                  <td className="small">{e.description}</td>
                  <td className="num"><Money c={e.amount} /></td>
                  <td className="small">{e.method_name ?? `Owed to ${e.supplier_name}`}</td>
                  <td>{e.status === 'voided' ? <><StatusBadge label="Cancelled" tone="red" /><div className="small muted">{e.void_reason}</div></> : <StatusBadge label="Recorded" tone="green" />}</td>
                  <td className="small muted">{e.created_by_name}</td>
                  <td>{can('void') && e.status === 'completed' && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setVoiding(e)}>Cancel</button>}</td>
                </tr>
              ))}
              {!list.loading && !list.data?.length && <tr><td colSpan={8} className="muted">Nothing in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {voiding && <ReasonModal open onClose={() => setVoiding(null)} title="Cancel expense?" action={`/expenses/${voiding.id}/void`} confirmLabel="Cancel expense"
        message={<>{voiding.category}: {money(voiding.amount)} on {voiding.entry_date}. The money is put back and the expense reversed.</>} onDone={list.reload} />}
    </div>
  );
}
