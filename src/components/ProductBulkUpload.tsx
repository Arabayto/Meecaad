import { useMemo, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { money, num, post, toCents } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Modal } from './Modal';

/**
 * Store products from a file or from rows copied out of Excel / Google Sheets:
 * name, cost price, selling price, quantity in stock (category optional).
 * Every row is checked on screen first; only the good rows are saved, in parts of 10
 * (each part all-or-nothing and safe to retry).
 */
interface Row { row: number; name: string; cost: string; price: string; qty: string; category: string; problem?: string }

const TEMPLATE = 'name,cost price,selling price,quantity,category\nRice 25kg,20.00,25.00,40,Rice & flour\nSugar 1kg,1.00,1.50,100,\nCooking oil 3L,7.00,9.00,12,Oil\n';
const CHUNK = 10;

/** Split CSV / TSV text into rows of cells (quotes, "" escapes and new lines inside quotes handled). */
export function parseTable(text: string): string[][] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const first = clean.split('\n')[0] ?? '';
  const sep = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  const rows: string[][] = [];
  let cell = '', row: string[] = [], quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { quoted = true; cell = ''; }
    else if (ch === sep) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell.trim() !== '' || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** "$1,200.50" → "1200.50"; returns null when it is not a number. */
const numberText = (v: string) => {
  const t = v.replace(/[$\s]/g, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (t === '') return '';
  return /^\d+(\.\d+)?$/.test(t) ? t : null;
};

const HEADERS: [keyof Row, RegExp][] = [
  ['name', /^(name|product|item|magac)/i], ['cost', /(cost|buy|purchase)/i], ['price', /(sell|sale|price)/i],
  ['qty', /(qty|quant|stock|count)/i], ['category', /(categ|group|type)/i],
];

export function readRows(text: string, existing: string[]): Row[] {
  const table = parseTable(text);
  if (!table.length) return [];
  // A first row with words like "name", "cost", "price" is the header: columns can be in any order.
  const head = table[0].map((c) => c.toLowerCase());
  const hasHeader = head.some((h) => /name|product|item|cost|price|qty|quant/.test(h)) && !head.some((h) => numberText(h));
  const col: Record<string, number> = { name: 0, cost: 1, price: 2, qty: 3, category: 4 };
  if (hasHeader) {
    for (const k of Object.keys(col)) col[k] = -1;
    head.forEach((h, i) => {
      for (const [k, re] of HEADERS) if (col[k] === -1 && re.test(h) && !Object.values(col).includes(i)) { col[k] = i; break; }
    });
  }
  const have = new Set(existing.map((n) => n.trim().toLowerCase()));
  const seen = new Set<string>();
  return table.slice(hasHeader ? 1 : 0).map((cells, i) => {
    const get = (k: string) => (col[k] >= 0 ? cells[col[k]] ?? '' : '');
    const r: Row = { row: i + 1, name: get('name'), cost: get('cost'), price: get('price'), qty: get('qty'), category: get('category') };
    const cost = numberText(r.cost), price = numberText(r.price), qty = numberText(r.qty);
    const key = r.name.trim().toLowerCase();
    if (!r.name.trim()) r.problem = 'No name';
    else if (r.name.length > 120) r.problem = 'Name is too long';
    else if (have.has(key)) r.problem = 'Already in your products';
    else if (seen.has(key)) r.problem = 'In the file twice';
    else if (cost === null) r.problem = `Cost price “${r.cost}” is not a number`;
    else if (price === null) r.problem = `Selling price “${r.price}” is not a number`;
    else if (qty === null) r.problem = `Quantity “${r.qty}” is not a number`;
    if (!r.problem) { seen.add(key); r.cost = cost ?? ''; r.price = price ?? ''; r.qty = qty ?? ''; }
    return r;
  });
}

export function ProductBulkUpload({ existing, onClose, onSaved }: { existing: string[]; onClose: () => void; onSaved: () => void }) {
  const { business, today } = useAuth();
  const { addToast } = useToast();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedRows, setSavedRows] = useState<Set<number>>(new Set());
  const [failed, setFailed] = useState<string>('');
  const [uploadId] = useState(() => crypto.randomUUID());
  const rows = useMemo(() => readRows(text, existing), [text, existing]);
  const good = rows.filter((r) => !r.problem && !savedRows.has(r.row));
  const bad = rows.filter((r) => r.problem && !savedRows.has(r.row));
  const value = good.reduce((s, r) => s + Math.round(Number(r.qty || 0) * toCents(r.cost || '0')), 0);

  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }));
    a.download = 'products-template.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const pick = async (file?: File) => {
    if (!file) return;
    if (/\.(xlsx?|ods)$/i.test(file.name)) { addToast('error', 'Save the sheet as CSV first (File → Save as → CSV), or copy the rows and paste them here.', 6000); return; }
    if (file.size > 2_000_000) { addToast('error', 'The file is too big (2 MB at most).', 4000); return; }
    setFileName(file.name); setSavedRows(new Set()); setFailed('');
    setText(await file.text());
  };
  const upload = async () => {
    setSaving(true); setFailed('');
    const done = new Set(savedRows);
    try {
      for (let i = 0; i < good.length; i += CHUNK) {
        const part = good.slice(i, i + CHUNK);
        // The key is fixed per part, so a retried part is never saved twice.
        const key = `${uploadId}-${part[0].row}-${part[part.length - 1].row}-${part.length}`;
        await post('/products/bulk', {
          business, date: today,
          rows: part.map((r) => ({ row: r.row, name: r.name.trim(), category: r.category.trim(), cost: toCents(r.cost || '0'), price: toCents(r.price || '0'), qty: Number(r.qty || 0) })),
        }, key);
        part.forEach((r) => done.add(r.row));
        setSavedRows(new Set(done));
      }
      addToast('success', `${done.size} products added`, 3000);
      onSaved(); onClose();
    } catch (e: any) {
      // Keep the window open: the saved rows are marked, the rest can be fixed and sent again.
      setFailed(`${done.size - savedRows.size} saved, then stopped: ${e.message}`);
      if (done.size > savedRows.size) onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Bulk upload products" width="lg"
      footer={<>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary" disabled={saving || !good.length} onClick={upload}>
          <Upload size={16} /> {saving ? `Saving… ${savedRows.size}/${good.length + savedRows.size}` : good.length ? `Add ${good.length} product${good.length === 1 ? '' : 's'}` : 'Add products'}
        </button>
      </>}>
      <div className="form-stack">
        <div className="bulk-steps">
          <div><strong>1.</strong> Columns: <strong>name, cost price, selling price, quantity</strong> (category optional). <button type="button" className="btn btn-ghost btn-xs" onClick={download}><Download size={13} /> Download template</button></div>
          <div><strong>2.</strong> Choose the CSV file, or copy the rows from Excel / Google Sheets and paste them below.</div>
        </div>
        <div className="row">
          <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
            <Upload size={14} /> Choose file
            <input type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {fileName && <span className="small muted">{fileName}</span>}
        </div>
        <textarea className="form-textarea bulk-paste" rows={5} value={text} placeholder={'name, cost price, selling price, quantity\nRice 25kg, 20, 25, 40'}
          onChange={(e) => { setText(e.target.value); setFileName(''); setSavedRows(new Set()); setFailed(''); }} aria-label="Rows" />
        {rows.length > 0 && (
          <>
            <div className="row" style={{ gap: 14 }}>
              <span className="pill pill--ok">{good.length} ready</span>
              {bad.length > 0 && <span className="pill pill--bad">{bad.length} with a problem (not added)</span>}
              {savedRows.size > 0 && <span className="pill">{savedRows.size} saved</span>}
              <span className="small muted">Stock value {money(value)} at cost</span>
            </div>
            {failed && <div className="mc-error">{failed}. Fix the row and press Add again — rows already saved are not sent twice.</div>}
            <div className="table-wrap bulk-preview">
              <table>
                <thead><tr><th>#</th><th>Name</th><th className="num">Cost</th><th className="num">Selling</th><th className="num">Qty</th><th>Category</th><th></th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.row} className={savedRows.has(r.row) ? 'bulk-row--saved' : r.problem ? 'bulk-row--bad' : ''}>
                      <td className="small muted">{r.row}</td>
                      <td><strong>{r.name || '—'}</strong></td>
                      <td className="num">{r.problem ? r.cost : money(toCents(r.cost || '0'))}</td>
                      <td className="num">{r.problem ? r.price : money(toCents(r.price || '0'))}</td>
                      <td className="num">{r.problem ? r.qty : num(Number(r.qty || 0))}</td>
                      <td className="small">{r.category}</td>
                      <td className="small">{savedRows.has(r.row) ? 'Saved' : r.problem ? <span className="pos-out">{r.problem}</span> : r.price && toCents(r.price) < toCents(r.cost || '0') ? <span className="muted">below cost</span> : 'OK'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
