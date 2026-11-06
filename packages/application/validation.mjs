export class BoundaryError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'BoundaryError';
    this.code = code;
    this.path = path;
  }
}

export function requireValue(condition, code, path, message) {
  if (!condition) throw new BoundaryError(code, path, message);
}

export function object(value, path) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value),
    'E_FORMAT', path, 'Expected an object');
  return value;
}

export function fields(value, required, optional, path) {
  object(value, path);
  requireValue(required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key)),
  'E_FORMAT', path, 'Missing or unsupported fields');
  return value;
}

export function array(value, path, limit = 100000) {
  requireValue(Array.isArray(value) && value.length <= limit, 'E_FORMAT', path, 'Expected a bounded array');
  return value;
}

export function text(value, path, limit = 500, allowEmpty = false) {
  requireValue(typeof value === 'string' && value.length <= limit &&
    (allowEmpty || value.trim().length > 0), 'E_FORMAT', path, 'Expected bounded text');
  return value;
}

export function day(value, path, minimum = '0001-01-01') {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= minimum,
    'E_DATE', path, `Expected YYYY-MM-DD on or after ${minimum}`);
  const parsed = new Date(`${value}T00:00:00Z`);
  requireValue(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value,
    'E_DATE', path, 'Invalid calendar date');
  return value;
}

export function period(row, path) {
  const from = day(row.valid_from, `${path}.valid_from`);
  const until = row.valid_to === null ? null : day(row.valid_to, `${path}.valid_to`);
  requireValue(until === null || from < until, 'E_DATE', path, 'Empty or reversed period');
  return { from, until };
}

export function active(row, onDate) {
  return row.from <= onDate && (row.until === null || onDate < row.until);
}

export function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function independent(value) {
  return freeze(structuredClone(value));
}

export function unique(rows, key, path) {
  const keys = rows.map(key);
  requireValue(new Set(keys).size === keys.length, 'E_DUPLICATE', path, 'Duplicate identity');
}

export function parseJson(input, path, maximumBytes = 5 * 1024 * 1024) {
  requireValue(typeof input === 'string' && new TextEncoder().encode(input).length <= maximumBytes,
    'E_FORMAT', path, 'Expected bounded UTF-8 JSON text');
  try {
    return JSON.parse(input);
  } catch {
    throw new BoundaryError('E_FORMAT', path, 'Invalid JSON');
  }
}

export async function sha256(input) {
  const bytes = new TextEncoder().encode(input);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
