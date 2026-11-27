/**
 * Read the first sheet of an Excel workbook (.xlsx / .xlsm, as saved by Excel, Google Sheets,
 * LibreOffice or Numbers) into rows of text, in the browser, with no library: an .xlsx file is a
 * zip of XML files. Only what a product list needs is read: text, numbers and true/false.
 */

const MAX_ENTRY = 40 * 1024 * 1024;   // refuse anything that would unpack to more than 40 MB

interface Entry { method: number; size: number; usize: number; offset: number }

function entries(buf: Uint8Array): Map<string, Entry> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: the last 22+ bytes (a comment may follow it).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not an Excel (.xlsx) file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Entry>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('The Excel file is damaged');
    const nameLen = dv.getUint16(p + 28, true), extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), usize: dv.getUint32(p + 24, true), offset: dv.getUint32(p + 42, true) });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

async function readEntry(buf: Uint8Array, e: Entry): Promise<string> {
  if (e.usize > MAX_ENTRY) throw new Error('The Excel file is too big');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(e.offset, true) !== 0x04034b50) throw new Error('The Excel file is damaged');
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  const data = buf.subarray(start, start + e.size);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error('This Excel file uses a format that cannot be read here');
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open Excel files. Update it, or save the sheet as CSV.');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ENTRY) { reader.cancel(); throw new Error('The Excel file is too big'); }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { all.set(part, at); at += part.length; }
  return new TextDecoder().decode(all);
}

const xml = (text: string) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The Excel file is damaged');
  return doc;
};
/** Elements by local name, whatever namespace prefix the writer used. */
const tags = (node: Document | Element, name: string) => Array.from(node.getElementsByTagNameNS('*', name));
const textOf = (el: Element) => tags(el, 't').map((t) => t.textContent ?? '').join('');

/** "B12" → column 1 (A = 0). */
const column = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** 1.1000000000000001 → "1.1" (how Excel shows it). */
const numberText = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(12))) : v;
};

export async function readXlsx(file: Blob): Promise<string[][]> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const files = entries(buf);
  const get = (name: string) => files.get(name) ?? files.get(name.replace(/^\//, ''));
  // The first sheet in the workbook's order (not always sheet1.xml).
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = get('xl/workbook.xml'), rels = get('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = tags(xml(await readEntry(buf, wb)), 'sheet')[0];
    const rid = first?.getAttribute('r:id') ?? first?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const target = tags(xml(await readEntry(buf, rels)), 'Relationship').find((r) => r.getAttribute('Id') === rid)?.getAttribute('Target');
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const sheet = get(sheetPath);
  if (!sheet) throw new Error('No sheet found in this Excel file');
  const sharedEntry = get('xl/sharedStrings.xml');
  const shared = sharedEntry ? tags(xml(await readEntry(buf, sharedEntry)), 'si').map(textOf) : [];

  const rows: string[][] = [];
  for (const row of tags(xml(await readEntry(buf, sheet)), 'row')) {
    const cells: string[] = [];
    let next = 0;
    for (const c of tags(row, 'c')) {
      const ref = c.getAttribute('r');
      const at = ref ? column(ref) : next;
      next = at + 1;
      const type = c.getAttribute('t');
      const v = tags(c, 'v')[0]?.textContent ?? '';
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(c);
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e') value = v;
      else value = v === '' ? '' : numberText(v);
      if (at >= 0 && at < 200) { while (cells.length < at) cells.push(''); cells[at] = value.trim(); }
    }
    if (cells.some((x) => x !== '')) rows.push(cells);
    if (rows.length > 20_000) throw new Error('The sheet has more than 20,000 rows. Split it into smaller files.');
  }
  return rows;
}
