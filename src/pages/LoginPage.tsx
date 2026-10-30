import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, Eye, EyeOff, Lock, ShieldCheck, User, UserPlus } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

// Same sign-in design as the Al-Hayat ERP, with Meecaad branding. On the very
// first run (no users yet) it creates the owner account instead.
export function LoginPage() {
  const { login, setup, setupRequired, user, loading: booting } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!booting && user) return <Navigate to="/" replace />;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (setupRequired) await setup(fullName, username, password);
      else await login(username, password);
      addToast('success', 'Welcome!');
      navigate('/');
    } catch (err: any) {
      setError(err?.message || 'Wrong username or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{`
        
        .login-root {
          font-family: 'Inter', sans-serif;
          min-height: 100vh;
          display: flex;
          background: radial-gradient(circle at 20% 20%, #0b8f08 0%, #066006 45%, #033a03 100%);
          position: relative;
          overflow: hidden;
        }

        /* Clean transparent overlay without blur so background stays razor sharp and crystal clear */
        .login-bg-pattern {
          position: absolute;
          inset: 0;
          background: radial-gradient(circle at 85% 90%, rgba(243,212,0,0.18), transparent 40%);
          z-index: 1;
        }

        /* Card - Premium Glassmorphism touch */
        .login-card {
          position: relative;
          z-index: 10;
          margin: auto;
          width: 100%;
          max-width: 420px;
          background: rgba(255, 255, 255, 0.94);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.6);
          border-radius: 20px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.5) inset;
          padding: 48px 40px;
          animation: fadeUp 0.5s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        /* Logo area */
        .login-logo-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          margin-bottom: 32px;
        }

        .login-logo-ring {
          width: 72px;
          height: 72px;
          border-radius: 12px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.05);
          overflow: hidden;
          margin-bottom: 20px;
          background: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .login-logo-ring img {
          width: 100%;
          height: 100%;
          object-fit: contain;
          padding: 8px;
        }

        .login-logo-fallback {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #0d5c0a;
          color: #ffffff;
          font-size: 24px;
          font-weight: 800;
        }

        .login-title {
          margin: 0 0 6px;
          font-size: 24px;
          font-weight: 700;
          color: #0f172a;
          text-align: center;
          letter-spacing: -0.02em;
        }

        .login-subtitle {
          margin: 0;
          font-size: 14px;
          color: #64748b;
          text-align: center;
          font-weight: 400;
        }

        /* Error */
        .login-error {
          display: flex;
          align-items: center;
          gap: 12px;
          background: #fef2f2;
          border: 1px solid #fecaca;
          color: #b91c1c;
          padding: 12px 16px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 500;
          margin-bottom: 24px;
        }

        /* Form */
        .login-form { display: grid; gap: 20px; }

        .login-field-label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          color: #334155;
          margin-bottom: 8px;
        }

        .login-input-wrap {
          position: relative;
          display: flex;
          align-items: center;
        }

        .login-input-icon {
          position: absolute;
          left: 14px;
          color: #94a3b8;
          display: flex;
          pointer-events: none;
        }

        .login-input {
          width: 100%;
          height: 44px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          padding: 0 40px;
          font-size: 14px;
          font-family: 'Inter', sans-serif;
          color: #0f172a;
          background: #ffffff;
          transition: all 0.2s;
          outline: none;
        }

        .login-input:focus {
          border-color: #0d5c0a;
          box-shadow: 0 0 0 3px rgba(13, 92, 10, 0.1);
        }

        .login-input::placeholder { color: #94a3b8; }

        .login-eye-btn {
          position: absolute;
          right: 14px;
          background: none;
          border: none;
          cursor: pointer;
          color: #94a3b8;
          display: flex;
          align-items: center;
          padding: 4px;
          transition: color 0.2s;
        }
        .login-eye-btn:hover { color: #0d5c0a; }

        /* Submit button */
        .login-btn {
          width: 100%;
          height: 44px;
          background: #0d5c0a;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          font-family: 'Inter', sans-serif;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: all 0.2s;
          margin-top: 8px;
        }

        .login-btn:hover:not(:disabled) {
          background: #0a4608;
        }

        .login-btn:disabled {
          opacity: 0.7;
          cursor: not-allowed;
        }

        /* Spinner */
        .login-spinner {
          width: 16px;
          height: 16px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Footer */
        .login-footer {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          margin-top: 32px;
          font-size: 12px;
          color: #64748b;
          font-weight: 500;
        }

        @media (max-width: 480px) {
          .login-card { margin: 16px; padding: 32px 24px; border-radius: 12px; }
          .login-title { font-size: 20px; }
        }
      `}</style>

      <div className="login-root">
        <div className="login-bg-pattern" />
        <div className="login-card">
          <div className="login-logo-wrap">
            <div className="login-logo-ring"><img src="/logo.svg" alt="Meecaad" /></div>
            <h1 className="login-title">{setupRequired ? 'Set up Meecaad' : 'Sign in to Meecaad'}</h1>
            <p className="login-subtitle">{setupRequired ? 'Create the owner account to start' : 'Restaurant & Cafe · Fuel Station · Store'}</p>
          </div>

          {error && (
            <div className="login-error"><AlertCircle size={16} /><span>{error}</span></div>
          )}

          <form className="login-form" onSubmit={handleSubmit}>
            {setupRequired && (
              <div>
                <label htmlFor="login-name" className="login-field-label">Owner full name</label>
                <div className="login-input-wrap">
                  <span className="login-input-icon"><UserPlus size={16} /></span>
                  <input id="login-name" className="login-input" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
                </div>
              </div>
            )}
            <div>
              <label htmlFor="login-username" className="login-field-label">Username</label>
              <div className="login-input-wrap">
                <span className="login-input-icon"><User size={16} /></span>
                <input id="login-username" className="login-input" value={username} onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. owner" autoComplete="username" autoCapitalize="none" required />
              </div>
            </div>
            <div>
              <label htmlFor="login-password" className="login-field-label">Password</label>
              <div className="login-input-wrap">
                <span className="login-input-icon"><Lock size={16} /></span>
                <input id="login-password" type={showPassword ? 'text' : 'password'} className="login-input" value={password}
                  onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••" minLength={setupRequired ? 8 : undefined}
                  autoComplete={setupRequired ? 'new-password' : 'current-password'} required />
                <button type="button" className="login-eye-btn" onClick={() => setShowPassword((p) => !p)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <button type="submit" className="login-btn" disabled={loading}>
              {loading ? <><div className="login-spinner" /> Please wait...</> : <>{setupRequired ? 'Create owner account' : 'Sign In'} <ArrowRight size={16} /></>}
            </button>
          </form>

          <div className="login-footer"><ShieldCheck size={14} /> Secure connection</div>
        </div>
      </div>
    </>
  );
}
