const NUMERIC_TYPES = new Set([
  'int2',
  'int4',
  'int8',
  'numeric',
  'float4',
  'float8',
  'money',
  'smallint',
  'integer',
  'bigint',
  'decimal',
  'real',
  'double precision',
  'oid',
]);
const DATE_TYPES = new Set(['date', 'timestamp', 'timestamptz', 'time', 'timetz']);
const INTEGER_TYPES = new Set(['int2', 'int4', 'int8', 'smallint', 'integer', 'bigint']);

export type ColumnTypeKind = 'numeric' | 'date' | 'bool' | 'other';

/** Coarse family of a Postgres type name (as shown in `QueryColumnDto.type`). */
export function columnTypeKind(type: string): ColumnTypeKind {
  const t = type.toLowerCase().trim();
  if (NUMERIC_TYPES.has(t) || /^(numeric|decimal)\(/.test(t)) return 'numeric';
  if (DATE_TYPES.has(t) || /^(timestamp|time)\b/.test(t)) return 'date';
  if (t === 'bool' || t === 'boolean') return 'bool';
  return 'other';
}

/** Integer-valued types and `numeric`: where a CPF/CNPJ stored as a number can hide. */
export function canHoldDocumentNumber(type: string): boolean {
  const t = type.toLowerCase().trim();
  return INTEGER_TYPES.has(t) || t === 'numeric' || /^(numeric|decimal)\(/.test(t);
}
