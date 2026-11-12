import { Fragment, useState } from 'react';
import { ShoppingBag } from 'lucide-react';
import { get, money, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../components/StatusBadge';
import { DateRange, ErrorBox, Field, Money, MoneyInput, PageHeader, PartySelect, ReasonModal, addDays, useLoad, useSubmit } from '../components/ui';

const CATEGORIES = ['Salaries', 'Rent', 'Electricity', 'Water', 'Generator fuel', 'Transport', 'Repairs', 'Gas / cooking fuel', 'Cleaning', 'Phone & internet', 'Taxes & licences', 'Other'];

export function ExpensesPage() {
  const { business, businessName, today, can, activeMethods } = useAuth();
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const list = useLoad(() => get('/expenses', { business, from, to }), [business, from, to]);
  // The restaurant records expenses when they are paid (it has no suppliers).
  const owedAllowed = business !== 'restaurant';
  const suppliers = useLoad(() => (owedAllowed ? get('/suppliers', { business }) : Promise.resolve([])), [business]);
  const [f, setF] = useState({ category: '', description: '', amount: '', method: 'cash', supplier: '', date: today });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const [voiding, setVoiding] = useState<any>(null);
  const { run, busy } = useSubmit();

  const save = async () => {
    const r = await run((key) => post('/expenses', {
      business, date: f.date, category: f.category, description: f.description, amount: toCents(f.amount),
      method: f.method === 'unpaid' ? undefined : f.method, supplier: f.method === 'unpaid' ? f.supplier : undefined,
    }, key), 'Expense saved');
    if (r) { setF({ ...f, description: '', amount: '' }); list.reload(); }
  };

  const rows = (list.data ?? []).filter((e: any) => e.status === 'completed');
  const byCat = Object.entries(rows.reduce((acc: Record<string, number>, e: any) => ({ ...acc, [e.category]: (acc[e.category] ?? 0) + e.amount }), {}))
    .sort((a, b) => (b[1] as number) - (a[1] as number));
  const total = rows.reduce((s: number, e: any) => s + e.amount, 0);

  return (
    <div className="module-page">
      <PageHeader icon={<ShoppingBag size={22} />} title={`Expenses — ${businessName(business)}`} subtitle="Running costs of the business (not stock for sale)" />
      <div className="grid-2">
        <div className="panel">
          <div className="panel__header"><div><p>New</p><h2>Record an expense</h2></div></div>
          <div className="form-stack">
            <div className="form-row">
              <Field label="Category">
                <input className="form-input" list="expense-categories" value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="Choose or type" />
                <datalist id="expense-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label="Amount"><MoneyInput value={f.amount} onChange={(v) => set('amount', v)} /></Field>
            </div>
            <Field label="Details (optional)"><input className="form-input" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="e.g. October salary – Ali" /></Field>
            <div className="form-row">
              <Field label="Paid with">
                <select className="form-select" value={f.method} onChange={(e) => set('method', e.target.value)}>
                  {activeMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  {owedAllowed && <option value="unpaid">Not paid yet (owed)</option>}
                </select>
              </Field>
              <Field label="Date"><input type="date" className="form-input" value={f.date} max={today} onChange={(e) => set('date', e.target.value)} /></Field>
            </div>
            {f.method === 'unpaid' && <Field label="Owed to"><PartySelect kind="suppliers" value={f.supplier} onChange={(v) => set('supplier', v)} items={suppliers.data ?? []} onCreated={suppliers.reload} placeholder="Choose…" /></Field>}
            <div className="form-actions">
              <button type="button" className="btn btn-primary" disabled={busy || !f.category.trim() || toCents(f.amount) <= 0 || (f.method === 'unpaid' && !f.supplier)} onClick={save}>Save expense</button>
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel__header"><div><p>This period</p><h2>{money(total)} spent</h2></div></div>
          <div className="kv">
            {byCat.map(([c, v]) => <Fragment key={c}><span>{c}</span><span>{money(v as number)}</span></Fragment>)}
            {!byCat.length && <span className="muted">No expenses yet.</span>}
          </div>
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
