import { Loader2 } from 'lucide-react';

interface LoadingSpinnerProps {
  size?: number;
  message?: string;
}

export function LoadingSpinner({ size = 24, message }: LoadingSpinnerProps) {
  return (
    <div className="loading-spinner" id="loading-spinner">
      <Loader2 size={size} className="loading-spinner__icon" />
      {message && <p className="loading-spinner__message">{message}</p>}
    </div>
  );
}

interface SkeletonProps {
  width?: string;
  height?: string;
  borderRadius?: string;
}

export function Skeleton({ width = '100%', height = '16px', borderRadius = '4px' }: SkeletonProps) {
  return (
    <div
      className="skeleton"
      style={{ width, height, borderRadius }}
    />
  );
}

export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="table-skeleton">
      <div className="table-skeleton__header">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} height="12px" width={`${60 + Math.random() * 40}%`} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <div key={rowIdx} className="table-skeleton__row">
          {Array.from({ length: columns }).map((_, colIdx) => (
            <Skeleton key={colIdx} height="14px" width={`${50 + Math.random() * 50}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="page-skeleton">
      <Skeleton height="32px" width="300px" />
      <div style={{ marginTop: 16, display: 'grid', gap: 14, gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <Skeleton height="100px" borderRadius="8px" />
        <Skeleton height="100px" borderRadius="8px" />
        <Skeleton height="100px" borderRadius="8px" />
        <Skeleton height="100px" borderRadius="8px" />
      </div>
      <div style={{ marginTop: 16 }}>
        <TableSkeleton />
      </div>
    </div>
  );
}
