import { useState, useEffect, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Inbox, ChevronLeft, ChevronRight } from 'lucide-react';
import { TableSkeleton } from './LoadingSpinner';

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (row: T) => ReactNode;
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (row: T) => string;
  loading?: boolean;
  emptyMessage?: string;
  emptyIcon?: ReactNode;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  onSort?: (columnKey: string) => void;
  onRowClick?: (row: T) => void;
  id?: string;
  pageSize?: number;
}

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  keyExtractor,
  loading = false,
  emptyMessage = 'No data found',
  emptyIcon,
  sortBy,
  sortOrder,
  onSort,
  onRowClick,
  id = 'data-table',
  pageSize = 25,
}: DataTableProps<T>) {
  const [page, setPage] = useState(1);

  // Reset to page 1 whenever data changes (e.g. filter applied)
  useEffect(() => {
    setPage(1);
  }, [data.length]);

  if (loading) {
    return <TableSkeleton rows={5} columns={columns.length} />;
  }

  if (!data.length) {
    return (
      <div className="empty-state" id={`${id}-empty`}>
        {emptyIcon ?? <Inbox size={48} />}
        <p>{emptyMessage}</p>
      </div>
    );
  }

  const totalPages = Math.ceil(data.length / pageSize);
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, data.length);
  const pageData = data.slice(start, end);

  const renderSortIcon = (col: Column<T>) => {
    if (!col.sortable) return null;
    if (sortBy === col.key) {
      return sortOrder === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />;
    }
    return <ArrowUpDown size={14} className="sort-icon--inactive" />;
  };

  return (
    <div>
      <div className="table-wrap" id={id}>
        <table>
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={col.width ? { width: col.width } : undefined}
                  className={col.sortable ? 'th--sortable' : ''}
                  onClick={() => col.sortable && onSort?.(col.key)}
                >
                  <span className="th__content">
                    {col.label}
                    {renderSortIcon(col)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageData.map((row) => (
              <tr
                key={keyExtractor(row)}
                className={onRowClick ? 'tr--clickable' : ''}
                onClick={() => onRowClick?.(row)}
              >
                {columns.map((col) => (
                  <td key={col.key}>
                    {col.render ? col.render(row) : (row[col.key] as ReactNode)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination bar — only shown when there is more than one page */}
      {totalPages > 1 && (
        <div className="pagination">
          <span className="pagination__info">
            Showing {start + 1}–{end} of {data.length}
          </span>
          <div className="pagination__controls">
            <button
              type="button"
              className="pagination__btn"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft size={15} />
            </button>

            {/* Page number buttons — show at most 5 around current */}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
              .reduce<(number | 'ellipsis')[]>((acc, p, idx, arr) => {
                if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push('ellipsis');
                acc.push(p);
                return acc;
              }, [])
              .map((p, i) =>
                p === 'ellipsis' ? (
                  <span key={`ell-${i}`} className="pagination__ellipsis">&hellip;</span>
                ) : (
                  <button
                    key={p}
                    type="button"
                    className={`pagination__btn${page === p ? ' pagination__btn--active' : ''}`}
                    onClick={() => setPage(p as number)}
                  >
                    {p}
                  </button>
                )
              )}

            <button
              type="button"
              className="pagination__btn"
              disabled={page === totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
          <span className="pagination__info" style={{ marginLeft: 'auto' }}>
            Page {page} of {totalPages}
          </span>
        </div>
      )}
    </div>
  );
}
