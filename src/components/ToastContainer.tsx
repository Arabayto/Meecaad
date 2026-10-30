import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Toast, ToastType } from '../contexts/ToastContext';

/* ─── Icons ──────────────────────────────────────────────────────────── */
function SuccessIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}
function ErrorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
function WarningIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

const ICON_MAP: Record<ToastType, React.ReactElement> = {
  success: <SuccessIcon />,
  error: <ErrorIcon />,
  warning: <WarningIcon />,
  info: <InfoIcon />,
};

const CONFIG: Record<ToastType, { accent: string; iconBg: string; iconColor: string; barColor: string; label: string }> = {
  success: {
    accent: '#16a34a',
    iconBg: '#f0fdf4',
    iconColor: '#16a34a',
    barColor: '#16a34a',
    label: 'Success',
  },
  error: {
    accent: '#dc2626',
    iconBg: '#fef2f2',
    iconColor: '#dc2626',
    barColor: '#dc2626',
    label: 'Error',
  },
  warning: {
    accent: '#d97706',
    iconBg: '#fffbeb',
    iconColor: '#d97706',
    barColor: '#d97706',
    label: 'Warning',
  },
  info: {
    accent: '#2563eb',
    iconBg: '#eff6ff',
    iconColor: '#2563eb',
    barColor: '#2563eb',
    label: 'Info',
  },
};

/* ─── Single Toast Item ───────────────────────────────────────────────── */
interface ToastItemProps {
  toast: Toast;
  onRemove: (id: string) => void;
}

function ToastItem({ toast, onRemove }: ToastItemProps) {
  const { type, message, duration = 1000 } = toast;
  const cfg = CONFIG[type];
  const [exiting, setExiting] = useState(false);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(duration);
  const startRef = useRef<number>(Date.now());

  const dismiss = () => {
    if (exiting) return;
    setExiting(true);
    setTimeout(() => onRemove(toast.id), 320);
  };

  const startTimer = (ms: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    startRef.current = Date.now();
    timerRef.current = setTimeout(dismiss, ms);
  };

  useEffect(() => {
    startTimer(duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleMouseEnter = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    remainingRef.current = remainingRef.current - (Date.now() - startRef.current);
    setPaused(true);
  };

  const handleMouseLeave = () => {
    setPaused(false);
    startTimer(remainingRef.current);
  };

  return (
    <div
      className={`erptoast${exiting ? ' erptoast--exit' : ' erptoast--enter'}`}
      role="alert"
      aria-live="assertive"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ '--toast-accent': cfg.accent } as React.CSSProperties}
    >
      {/* Left accent bar */}
      <div className="erptoast__accent" />

      {/* Icon */}
      <div className="erptoast__icon" style={{ background: cfg.iconBg, color: cfg.iconColor }}>
        {ICON_MAP[type]}
      </div>

      {/* Body */}
      <div className="erptoast__body">
        <span className="erptoast__label">{cfg.label}</span>
        <span className="erptoast__message">{message}</span>
      </div>

      {/* Dismiss button */}
      <button className="erptoast__close" onClick={dismiss} aria-label="Dismiss">
        <CloseIcon />
      </button>

      {/* Progress bar — CSS animation driven, pauses on hover */}
      <div
        className={`erptoast__bar${paused ? ' erptoast__bar--paused' : ''}`}
        style={{
          '--bar-color': cfg.barColor,
          '--bar-duration': `${duration}ms`,
        } as React.CSSProperties}
      />
    </div>
  );
}

/* ─── Toast Container Portal ─────────────────────────────────────────── */
interface ToastContainerProps {
  toasts: Toast[];
  onRemove: (id: string) => void;
}

export function ToastContainer({ toasts, onRemove }: ToastContainerProps) {
  return createPortal(
    <div className="erptoast-stack" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>,
    document.body
  );
}
