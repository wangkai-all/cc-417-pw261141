/**
 * Untrusted input parsing. Nothing here interpolates file content into code or
 * builds paths outside the manifest directory. Row limits bound memory use.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LIMITS = { maxFileBytes: 32 * 1024 * 1024, maxRows: 200000, maxFieldChars: 4096 };

export function resolveInput(baseDir, rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('batch file must be a non-empty string');
  const abs = path.resolve(baseDir, rel);
  const root = path.resolve(baseDir) + path.sep;
  if (!abs.startsWith(root)) throw new Error(`batch file escapes the dataset directory: ${rel}`);
  return abs;
}

export function readInputFile(abs) {
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error(`not a regular file: ${abs}`);
  if (stat.size > LIMITS.maxFileBytes) throw new Error(`file exceeds ${LIMITS.maxFileBytes} bytes: ${abs}`);
  return fs.readFileSync(abs, 'utf8');
}

/** RFC4180-ish parser with quoted fields, embedded commas/newlines and CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let line = 1;
  const pushField = () => {
    if (field.length > LIMITS.maxFieldChars) throw new Error(`CSV field too long near line ${line}`);
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.length === 1 && row[0] === '') {
      row = [];
    } else {
      rows.push({ line, values: row });
      if (rows.length > LIMITS.maxRows) throw new Error('CSV row limit exceeded');
      row = [];
    }
  };
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      if (c === '\n') line++;
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (field.length > 0) throw new Error(`CSV: stray quote at line ${line}`);
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      pushField();
      i++;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      i += 2;
      pushRow();
      line++;
      continue;
    }
    if (c === '\n') {
      pushRow();
      line++;
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (quoted) throw new Error('CSV: unterminated quoted field');
  if (field.length > 0 || row.length > 0) pushRow();
  if (rows.length === 0) return [];
  const header = rows[0].values.map((h) => h.trim());
  if (new Set(header).size !== header.length) throw new Error('CSV: duplicate column names');
  return rows.slice(1).map((r) => {
    if (r.values.length !== header.length) {
      throw new Error(`CSV line ${r.line}: expected ${header.length} fields, got ${r.values.length}`);
    }
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = r.values[idx];
    });
    obj.__line = r.line;
    return obj;
  });
}

export function parseJsonLines(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`JSONL line ${idx + 1}: ${err.message}`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`JSONL line ${idx + 1}: expected an object`);
    }
    value.__line = idx + 1;
    out.push(value);
    if (out.length > LIMITS.maxRows) throw new Error('row limit exceeded');
  });
  return out;
}

export function parseJsonArray(text) {
  const value = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error('JSON batch must be an array of objects');
  if (value.length > LIMITS.maxRows) throw new Error('row limit exceeded');
  return value.map((v, idx) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`row ${idx + 1}: expected an object`);
    return { ...v, __line: idx + 1 };
  });
}

export function parseRows(text, format) {
  switch (format) {
    case 'csv':
      return parseCsv(text);
    case 'jsonl':
      return parseJsonLines(text);
    case 'json':
      return parseJsonArray(text);
    default:
      throw new Error(`unsupported format: ${format}`);
  }
}

export function formatFor(file, declared) {
  if (declared) {
    if (!['csv', 'jsonl', 'json'].includes(declared)) throw new Error(`unsupported format: ${declared}`);
    return declared;
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  if (ext === '.json') return 'json';
  throw new Error(`cannot infer format from extension: ${file}`);
}

export function requireString(value, field, { max = LIMITS.maxFieldChars } = {}) {
  if (value === undefined || value === null) throw new Error(`${field} is required`);
  const s = String(value).trim();
  if (!s) throw new Error(`${field} is required`);
  if (s.length > max) throw new Error(`${field} is too long`);
  return s;
}

export function optionalString(value, max = LIMITS.maxFieldChars) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new Error('field is too long');
  return s;
}

export function requireNumber(value, field) {
  if (typeof value === 'string' && value.trim() === '') throw new Error(`${field} is required`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a finite number, got ${JSON.stringify(value)}`);
  return n;
}
