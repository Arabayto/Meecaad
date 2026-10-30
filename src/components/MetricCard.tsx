import type { ReactNode } from 'react';

type MetricCardProps = {
  label: string;
  value: string;
  trend?: string;
  icon: ReactNode;
  onClick?: () => void;
  id?: string;
};

export function MetricCard({ label, value, trend, icon, onClick, id }: MetricCardProps) {
  return (
    <section
      className={`metric-card ${onClick ? 'metric-card--clickable' : ''}`}
      onClick={onClick}
      id={id}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="metric-card__icon">{icon}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <p title={label}>{label}</p>
        <strong title={value}>{value}</strong>
        {trend && <span title={trend}>{trend}</span>}
      </div>
    </section>
  );
}
