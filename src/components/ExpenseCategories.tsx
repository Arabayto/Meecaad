// Expense categories, registered in advance per business by the manager or owner.
// Everyone recording an expense chooses one of them (the server refuses anything else).
import { useState } from 'react';
import { get, patch, post } from '../api';
import { ErrorBox, useLoad, useSubmit } from './ui';

/** Expense categories registered in advance; expenses are chosen from this list. */
export function ExpenseCategories({ business, embedded = false }: { business: string; embedded?: boolean }) {
  const list = useLoad(() => get('/expense-categories', { business }), [business]);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const { run, busy } = useSubmit();
  const add = async () => { if (await run((key) => post('/expense-categories', { business, name }, key), 'Category added')) { setName(''); list.reload(); } };
  const change = async (id: string, body: object, msg: string) => { if (await run(() => patch(`/expense-categories/${id}`, body), msg)) { setRenaming(null); list.reload(); } };
  return (
    <div className={embedded ? 'form-stack' : 'panel form-stack'}>
      {!embedded && <div className="panel__header"><div><p>Expenses</p><h2>Expense categories</h2></div></div>}
      <p className="small muted" style={{ margin: 0 }}>Everyone recording an expense chooses one of these. Hidden categories are no longer offered; past expenses keep their category.</p>
      <div className="row" style={{ gap: 8 }}>
        <input className="form-input" style={{ flex: '1 1 220px', maxWidth: 360 }} value={name} placeholder="New category, e.g. Security guard" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) add(); }} />
        <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={add}>Add category</button>
      </div>
      <ErrorBox error={list.error} />
      <div className="table-wrap">
        <table>
          <tbody>
            {(list.data ?? []).map((c: any) => (
              <tr key={c.id} style={{ opacity: c.active ? 1 : 0.55 }}>
                <td>{renaming && renaming.id === c.id
                  ? <input className="form-input" value={renaming.name} autoFocus onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && renaming.name.trim()) change(c.id, { name: renaming.name }, 'Renamed'); }} />
                  : <strong>{c.name}</strong>}{!c.active && <span className="small muted"> (hidden)</span>}</td>
                <td style={{ textAlign: 'right' }}>
                  {renaming && renaming.id === c.id
                    ? <><button type="button" className="btn btn-ghost btn-xs" onClick={() => setRenaming(null)}>Cancel</button><button type="button" className="btn btn-primary btn-xs" disabled={busy || !renaming.name.trim()} onClick={() => change(c.id, { name: renaming.name }, 'Renamed')}>Save</button></>
                    : <><button type="button" className="btn btn-ghost btn-xs" onClick={() => setRenaming({ id: c.id, name: c.name })}>Rename</button>
                      <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => change(c.id, { active: !c.active }, c.active ? 'Hidden' : 'Shown again')}>{c.active ? 'Hide' : 'Show'}</button></>}
                </td>
              </tr>
            ))}
            {!list.loading && !list.data?.length && <tr><td className="muted">No categories yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

