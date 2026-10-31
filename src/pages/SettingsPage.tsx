import { useState } from 'react';
import { Settings } from 'lucide-react';
import { get, patch, post } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { PageHeader, useLoad, useSubmit } from '../components/ui';

/** Owner settings shared by all businesses: the payment methods (each business keeps its own balance per method). */
export function SettingsPage() {
  const { reload } = useAuth();
  const methods = useLoad(() => get('/payment-methods'), []);
  const [newMethod, setNewMethod] = useState('');
  const { run, busy } = useSubmit();

  const addMethod = async () => {
    const r = await run(() => post('/payment-methods', { name: newMethod }), 'Payment method added');
    if (r) { setNewMethod(''); methods.reload(); reload(); }
  };
  const toggleMethod = async (m: any) => {
    const r = await run(() => patch(`/payment-methods/${m.id}`, { active: !m.active }), 'Saved');
    if (r) { methods.reload(); reload(); }
  };

  return (
    <div className="module-page">
      <PageHeader icon={<Settings size={22} />} title="Settings" subtitle="Shared by all three businesses" />
      <div className="panel">
        <div className="panel__header"><div><p>Payment methods</p><h2>How customers can pay</h2></div></div>
        <div className="row" style={{ marginBottom: 12 }}>
          {(methods.data ?? []).map((m: any) => (
            <span key={m.id} className="row" style={{ border: '1px solid var(--border)', borderRadius: 20, padding: '4px 6px 4px 12px' }}>
              <strong style={{ opacity: m.active ? 1 : 0.5 }}>{m.name}</strong>
              {m.id !== 'cash' && <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => toggleMethod(m)}>{m.active ? 'Turn off' : 'Turn on'}</button>}
            </span>
          ))}
        </div>
        <div className="row">
          <input className="form-input" style={{ maxWidth: 240 }} placeholder="e.g. Bank, Sahal, Premier Wallet" value={newMethod} onChange={(e) => setNewMethod(e.target.value)} />
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !newMethod.trim()} onClick={addMethod}>Add method</button>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>Each method is a separate money account in each business (e.g. Store Zaad and Fuel Station Zaad are different balances). Methods are never deleted, only turned off.</p>
      </div>
    </div>
  );
}
