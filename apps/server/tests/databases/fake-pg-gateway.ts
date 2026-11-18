import type {
  PgCatalogColumn,
  PgCatalogSnapshot,
  PgColumnSummary,
  PgConnectionParams,
  PgGateway,
  PgQueryResult,
  PgServerInfo,
  PgTableDetail,
  PgTableInfo,
} from '../../src/contexts/databases/domain/ports';

/**
 * In-memory Postgres for tests: canned catalog + a `respond` hook for queries. Records every call
 * (the SQL that reached the "database") so tests can assert what was — or was not — executed.
 */
export class FakePgGateway implements PgGateway {
  queries: { conn: PgConnectionParams; sql: string; maxRows: number }[] = [];
  tested: PgConnectionParams[] = [];
  invalidated: string[] = [];
  closed = 0;
  /** SQL that went through `EXPLAIN` before running (`explainFirst`). */
  explained: string[] = [];
  /** SQL checked by `explainOnly` (parsed and planned, never run). */
  explainedOnly: string[] = [];
  /** Throws (e.g. a connection error) from `explainOnly` and from the catalog calls when set. */
  unreachable: Error | null = null;
  snapshotCalls = 0;
  columnsCalls: { schema: string; name: string }[][] = [];
  searchPath = ['public', 'pg_catalog'];
  failTest: string | null = null;
  info: PgServerInfo = { serverVersion: 'PostgreSQL 17.0', currentUser: 'leitor', canWrite: false };

  tables: PgTableDetail[] = [
    {
      schema: 'public',
      name: 'contribuintes',
      kind: 'table',
      comment: 'Cadastro de contribuintes',
      estimatedRows: 3,
      columns: [
        { name: 'id', type: 'int4', nullable: false, defaultValue: null, comment: null },
        { name: 'nome', type: 'text', nullable: false, defaultValue: null, comment: 'Nome' },
        { name: 'cpf', type: 'varchar', nullable: true, defaultValue: null, comment: null },
        { name: 'exercicio', type: 'int4', nullable: false, defaultValue: null, comment: null },
        { name: 'valor', type: 'numeric', nullable: false, defaultValue: null, comment: null },
        { name: 'vencimento', type: 'date', nullable: true, defaultValue: null, comment: null },
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      indexes: [{ name: 'contribuintes_pkey', definition: 'CREATE UNIQUE INDEX ... (id)' }],
    },
    {
      schema: 'public',
      name: 'cgm',
      kind: 'table',
      comment: 'Cadastro geral de contribuintes',
      estimatedRows: 3,
      columns: [
        { name: 'id', type: 'int4', nullable: false, defaultValue: null, comment: null },
        { name: 'z01_numcgm', type: 'int4', nullable: false, defaultValue: null, comment: null },
        { name: 'z01_nome', type: 'varchar', nullable: false, defaultValue: null, comment: null },
        {
          name: 'z01_nomecomple',
          type: 'varchar',
          nullable: true,
          defaultValue: null,
          comment: null,
        },
        { name: 'z01_cgccpf', type: 'varchar', nullable: true, defaultValue: null, comment: null },
        { name: 'situacao', type: 'text', nullable: true, defaultValue: null, comment: null },
      ],
      primaryKey: ['z01_numcgm'],
      foreignKeys: [],
      indexes: [],
    },
  ];

  /** Result of `query()`; replace it per test. Throwing simulates a Postgres error. */
  respond: (sql: string) => PgQueryResult = () => ({
    columns: [
      { name: 'id', type: 'int4' },
      { name: 'nome', type: 'text' },
      { name: 'cpf', type: 'varchar' },
      { name: 'valor', type: 'numeric' },
    ],
    rows: [
      [1, 'Maria da Silva', '10123456760', '150.00'],
      [2, 'João Souza', '20987654321', '99.90'],
      [3, 'Ana Lima', null, '0.00'],
    ],
    truncated: false,
    durationMs: 4,
  });

  /**
   * What Postgres' own analysis would say about a statement (`EXPLAIN`): throw to simulate a name
   * error, e.g. `Object.assign(new Error('column "x" does not exist'), { code: '42703', phase: 'validation' })`.
   */
  explainCheck: (sql: string) => void = () => undefined;

  async test(conn: PgConnectionParams): Promise<PgServerInfo> {
    this.tested.push(conn);
    if (this.failTest) throw new Error(this.failTest);
    return this.info;
  }

  async query(
    conn: PgConnectionParams,
    sql: string,
    opts: { maxRows: number; explainFirst?: boolean },
  ): Promise<PgQueryResult> {
    if (opts.explainFirst && !/^\s*explain\b/i.test(sql)) {
      this.explained.push(sql);
      this.explainCheck(sql);
    }
    this.queries.push({ conn, sql, maxRows: opts.maxRows });
    const result = this.respond(sql);
    if (result.rows.length > opts.maxRows) {
      return { ...result, rows: result.rows.slice(0, opts.maxRows), truncated: true };
    }
    return result;
  }

  async explainOnly(_conn: PgConnectionParams, sql: string): Promise<void> {
    if (this.unreachable) throw this.unreachable;
    this.explainedOnly.push(sql);
    this.explainCheck(sql);
  }

  async catalogSnapshot(
    _conn: PgConnectionParams,
    opts: { schemas: string[] },
  ): Promise<PgCatalogSnapshot> {
    if (this.unreachable) throw this.unreachable;
    this.snapshotCalls += 1;
    return {
      tables: this.tables
        .filter((t) => opts.schemas.length === 0 || opts.schemas.includes(t.schema))
        .map(({ schema, name, kind }) => ({ schema, name, kind })),
      searchPath: this.searchPath,
    };
  }

  async columnsOf(
    _conn: PgConnectionParams,
    tables: { schema: string; name: string }[],
  ): Promise<Map<string, PgCatalogColumn[]>> {
    this.columnsCalls.push(tables);
    const out = new Map<string, PgCatalogColumn[]>();
    for (const t of tables) {
      const found = this.tables.find((x) => x.schema === t.schema && x.name === t.name);
      if (found)
        out.set(
          `${t.schema}.${t.name}`,
          found.columns.map((c) => ({ name: c.name, type: c.type })),
        );
    }
    return out;
  }

  async listTables(
    _conn: PgConnectionParams,
    opts: { filter?: string; limit: number },
  ): Promise<PgTableInfo[]> {
    const f = opts.filter?.toLowerCase();
    return this.tables
      .filter((t) => !f || t.name.includes(f) || (t.comment ?? '').toLowerCase().includes(f))
      .slice(0, opts.limit)
      .map(({ schema, name, kind, comment, estimatedRows }) => ({
        schema,
        name,
        kind,
        comment,
        estimatedRows,
      }));
  }

  async describeTable(_conn: PgConnectionParams, table: string): Promise<PgTableDetail | null> {
    const name = table.includes('.') ? table.split('.').pop()! : table;
    return this.tables.find((t) => t.name === name) ?? null;
  }

  async columnSummary(
    _conn: PgConnectionParams,
    table: string,
    column: string,
  ): Promise<PgColumnSummary | null> {
    const detail = await this.describeTable(_conn, table);
    const col = detail?.columns.find((c) => c.name === column);
    if (!detail || !col) return null;
    const numericOrDate = /int|numeric|date|time/.test(col.type);
    return {
      schema: detail.schema,
      table: detail.name,
      column,
      type: col.type,
      total: 3,
      nulls: column === 'cpf' ? 1 : 0,
      distinct: 3,
      min: numericOrDate ? (col.type === 'date' ? '2021-01-10' : '2021') : null,
      max: numericOrDate ? (col.type === 'date' ? '2025-12-20' : '2025') : null,
    };
  }

  async invalidate(connectionId: string): Promise<void> {
    this.invalidated.push(connectionId);
  }

  async closeAll(): Promise<void> {
    this.closed += 1;
  }
}
