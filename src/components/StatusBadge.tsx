type StatusBadgeProps = {
  label: string;
  tone?: 'green' | 'yellow' | 'red' | 'neutral' | 'blue';
};

export function StatusBadge({ label, tone = 'neutral' }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone}`}>{label}</span>;
}

// Role badge variant
export function RoleBadge({ name }: { name: string }) {
  const tone = name.toLowerCase().includes('admin')
    ? 'red'
    : name.toLowerCase().includes('manager')
    ? 'green'
    : 'neutral';
  return <span className={`role-badge role-badge--${tone}`}>{name}</span>;
}
