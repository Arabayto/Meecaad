// API client. The session lives in an HttpOnly cookie set by /api/auth/*;
// the page never sees a token. Every POST carries an Idempotency-Key so a
// double click or a retried request can never save the same thing twice.

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

async function request<T>(method: string, path: string, body?: unknown, key?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Requested-With': 'meecaad' };
  if (method === 'POST') headers['Idempotency-Key'] = key ?? crypto.randomUUID();
  let res: Response;
  try {
    res = await fetch('/api' + path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'No connection. Check the internet and try again — nothing is saved twice.');
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
  if (!res.ok) throw new ApiError(res.status, data?.message ?? `Error ${res.status}`);
  return data as T;
}

export const get = <T = any>(path: string, params?: Record<string, string | undefined>) => {
  const qs = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString() : '';
  return request<T>('GET', path + (qs ? `?${qs}` : ''));
};
export const post = <T = any>(path: string, body?: unknown, key?: string) => request<T>('POST', path, body ?? {}, key);
export const patch = <T = any>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {});

// ── Money ── amounts travel as integer cents.
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = (c: number | null | undefined) => usd.format((c ?? 0) / 100 || 0);
export const toCents = (v: string | number) => Math.round(Number(String(v).replace(/,/g, '')) * 100) || 0;
export const fromCents = (c: number) => (c / 100).toFixed(2);
export const num = (n: number | null | undefined, digits = 3) => Number((n ?? 0).toFixed(digits)).toLocaleString('en-US');
