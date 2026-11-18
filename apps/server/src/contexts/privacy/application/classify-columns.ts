import type { PiiKind, QueryColumnDto } from '@thinkflow/shared';
import { columnRefKey, WILDCARD, type ColumnRef } from '../domain/column-rule';
import { piiKindOfMask, sensitiveKindByName } from '../domain/column-names';
import { canHoldDocumentNumber, columnTypeKind } from '../domain/column-types';
import { isValidCnpj, isValidCpf } from '../domain/detectors';
import type {
  ClassificationOrigin,
  ColumnAction,
  ColumnClassification,
} from '../domain/classification';
import type { ColumnRuleRepository } from '../domain/ports';

const SAMPLE_SCAN_ROWS = 200;
/** Share of the non-null sampled values that must validate to call a numeric column a document. */
const DOCUMENT_SHARE = 0.5;

function digitsOf(value: unknown): string | null {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return /^\d+$/.test(v) ? v : null;
}

/** CPF/CNPJ stored as a number lose their leading zeros, so short values are padded back. */
function documentKindOf(digits: string): PiiKind | null {
  if (digits.length >= 9 && digits.length <= 11 && isValidCpf(digits.padStart(11, '0')))
    return 'CPF';
  if (digits.length >= 12 && digits.length <= 14 && isValidCnpj(digits.padStart(14, '0')))
    return 'CNPJ';
  return null;
}

/** CPF/CNPJ kind when most sampled values of a numeric column validate as documents. */
function numericDocumentKind(rows: readonly unknown[][], index: number): PiiKind | null {
  const counts = new Map<PiiKind, number>();
  let seen = 0;
  for (const row of rows.slice(0, SAMPLE_SCAN_ROWS)) {
    const value = row[index];
    if (value === null || value === undefined) continue;
    seen += 1;
    const digits = digitsOf(value);
    const kind = digits ? documentKindOf(digits) : null;
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (seen === 0) return null;
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return best && best[1] / seen >= DOCUMENT_SHARE ? best[0] : null;
}

/**
 * What the AI may get of each column of a result. Order: analyst rule > auto rule > name of the
 * REAL source column (never the alias) > type.
 * - numeric/date/bool without a sensitive name → `reveal` (auto), unless the values are CPF/CNPJ;
 * - sensitive name → `tokenize` (auto, with the kind the name suggests);
 * - text/json/other without a rule → `unclassified` (the analyst reviews it);
 * - an expression (no source column): numeric/date/bool → `reveal` (default; counts and sums are
 *   not personal data), anything else → `tokenize` (default; the analyst may release it for this
 *   query only).
 * A column whose source is unknown (`source` undefined) is judged by its own name.
 */
export async function classifyColumns(input: {
  connectionId: string;
  columns: readonly QueryColumnDto[];
  rules: ColumnRuleRepository;
  rows?: readonly unknown[][];
}): Promise<ColumnClassification[]> {
  const { columns, rows = [] } = input;
  const refs: (ColumnRef | null)[] = columns.map((c) => {
    if (c.source === null) return null;
    return c.source ?? { schema: WILDCARD, table: WILDCARD, column: c.name };
  });
  const found = await input.rules.findFor(
    input.connectionId,
    refs.filter((r): r is ColumnRef => r !== null),
  );

  return columns.map((col, i): ColumnClassification => {
    const ref = refs[i] ?? null;
    const expression = col.source === null;
    const plain = columnTypeKind(col.type) !== 'other';
    const docKind = plain && canHoldDocumentNumber(col.type) ? numericDocumentKind(rows, i) : null;
    const make = (
      action: ColumnAction,
      kind: PiiKind | null,
      origin: ClassificationOrigin,
    ): ColumnClassification => ({ action, kind, origin, ref, expression });

    if (ref === null) {
      if (docKind) return make('tokenize', docKind, 'default');
      return plain ? make('reveal', null, 'default') : make('tokenize', null, 'default');
    }

    const rule = found.get(columnRefKey(ref));
    if (rule) return make(rule.action, rule.action === 'tokenize' ? rule.kind : null, rule.origin);

    const byName = sensitiveKindByName(ref.column);
    if (byName) return make('tokenize', piiKindOfMask(byName, ref.column), 'auto');
    if (docKind) return make('tokenize', docKind, 'auto');
    if (plain) return make('reveal', null, 'auto');
    return make('unclassified', null, 'default');
  });
}
