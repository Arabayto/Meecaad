import { useState } from 'react';
import { FileClock } from 'lucide-react';
import { get } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { BizTag, DateRange, ErrorBox, PageHeader, addDays, fmtTime, useLoad } from '../components/ui';

/** Who created, changed, cancelled, closed or reopened what — append-only. */
export function AuditPage() {
  const { today } = useAuth();
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [q, setQ] = useState('');
  const list = useLoad(() => get('/audit', { from, to }), [from, to]);
  const rows = (list.data ?? []).filter((a: any) => !q || `${a.user_name} ${a.action} ${a.entity} ${a.details ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="module-page">
      <PageHeader icon={<FileClock size={22} />} title="Audit log" subtitle="Every important action, who did it and when. Nothing here can be changed or deleted." />
      <div className="panel">
        <div className="row row--between" style={{ marginBottom: 12 }}>
          <DateRange from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b); }} />
          <input className="form-input" style={{ maxWidth: 260 }} placeholder="Search user, action, details" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ErrorBox error={list.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Business</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((a: any) => (
                <tr key={a.id}>
                  <td className="small">{fmtTime(a.created_at)}</td>
                  <td>{a.user_name ?? '—'}</td>
                  <td><strong>{a.action.replace(/_/g, ' ')}</strong></td>
                  <td className="small">{a.entity.replace(/_/g, ' ')}</td>
                  <td>{a.business_id && <BizTag id={a.business_id} />}</td>
                  <td className="small" style={{ maxWidth: 420, wordBreak: 'break-word' }}>{a.details}</td>
                </tr>
              ))}
              {!list.loading && !rows.length && <tr><td colSpan={6} className="muted">Nothing in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
