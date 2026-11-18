import type { QueryColumnDto } from '@thinkflow/shared';

/** Postgres types whose values sort and align as numbers. */
const NUMERIC_TYPES = new Set([
  'int2',
  'int4',
  'int8',
  'smallint',
  'integer',
  'bigint',
  'float4',
  'float8',
  'real',
  'double precision',
  'numeric',
  'decimal',
  'money',
  'oid',
]);

export const isNumericType = (type: string): boolean => NUMERIC_TYPES.has(type.toLowerCase());

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/** A cell as plain text (null = empty). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Orders two cells: nulls last, numeric columns as numbers, everything else "naturally". */
export function compareCells(a: unknown, b: unknown, numeric: boolean): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
  if (numeric || (typeof a === 'number' && typeof b === 'number')) {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  }
  return collator.compare(cellText(a), cellText(b));
}

/**
 * Row indexes ordered by one column. Nulls stay last in both directions, ties keep the original
 * order (stable).
 */
export function sortedIndexes(
  rows: unknown[][],
  column: number,
  type: string,
  direction: 'asc' | 'desc',
): number[] {
  const numeric = isNumericType(type);
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((_, i) => i)
    .sort((i, j) => {
      const a = rows[i]![column];
      const b = rows[j]![column];
      const aNull = a === null || a === undefined;
      const bNull = b === null || b === undefined;
      if (aNull || bNull) return aNull === bNull ? i - j : aNull ? 1 : -1;
      return sign * compareCells(a, b, numeric) || i - j;
    });
}

/** UTF-8 byte order mark: makes Excel read accents correctly. */
const BOM = String.fromCharCode(0xfeff);

function csvField(value: unknown): string {
  const text = cellText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel opens accents correctly. */
export function toCsv(columns: QueryColumnDto[], rows: unknown[][]): string {
  const lines = [columns.map((c) => csvField(c.name)).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** Tab-separated text that pastes into Excel as cells. */
export function toTsv(columns: QueryColumnDto[], rows: unknown[][]): string {
  const clean = (value: unknown) => cellText(value).replace(/[\t\r\n]+/g, ' ');
  return [columns.map((c) => clean(c.name)).join('\t'), ...rows.map((r) => r.map(clean).join('\t'))]
    .join('\r\n')
    .concat('\r\n');
}

/** Starts a browser download of `content`. */
export function downloadText(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** SQL typed by the analyst (not a question): starts with SELECT/WITH/EXPLAIN/TABLE/VALUES/SHOW. */
export function looksLikeSql(text: string): boolean {
  return /^\s*(\(\s*)*(select|with|table|values|explain|show)\b/i.test(text);
}
