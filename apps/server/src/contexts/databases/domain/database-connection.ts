import type { DatabaseAiAccess, DatabaseSslMode } from '@thinkflow/shared';
import type { PgConnectionParams } from './ports';

export interface DatabaseConnectionProps {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  /** Plain text here; encrypted by the repository. */
  password: string;
  sslMode: DatabaseSslMode;
  schemas: string[];
  aiAccess: DatabaseAiAccess;
  sampleRows: number;
  sensitiveColumns: string[];
  revealColumns: string[];
  statementTimeoutSec: number;
  maxRows: number;
  isDefault: boolean;
  /** MCP server (and its project) with the data dictionary used to suggest names; null = none. */
  metadataMcpServerId: string | null;
  metadataMcpProject: string | null;
  createdAt: number;
  updatedAt: number;
}

export type DatabaseConnectionInit = Omit<
  DatabaseConnectionProps,
  'id' | 'createdAt' | 'updatedAt'
>;
export type DatabaseConnectionChanges = Partial<DatabaseConnectionInit>;

/** Aggregate: one registered Postgres connection and the rules for what the AI may see of it. */
export class DatabaseConnection {
  private constructor(private props: DatabaseConnectionProps) {}

  static create(input: DatabaseConnectionInit, now: number, id: string): DatabaseConnection {
    return new DatabaseConnection({
      ...input,
      schemas: [...input.schemas],
      sensitiveColumns: [...input.sensitiveColumns],
      revealColumns: [...input.revealColumns],
      id,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: DatabaseConnectionProps): DatabaseConnection {
    return new DatabaseConnection({
      ...props,
      schemas: [...props.schemas],
      sensitiveColumns: [...props.sensitiveColumns],
      revealColumns: [...props.revealColumns],
    });
  }

  get id() {
    return this.props.id;
  }
  get name() {
    return this.props.name;
  }
  get database() {
    return this.props.database;
  }
  get schemas() {
    return this.props.schemas;
  }
  get aiAccess() {
    return this.props.aiAccess;
  }
  get sampleRows() {
    return this.props.sampleRows;
  }
  get sensitiveColumns() {
    return this.props.sensitiveColumns;
  }
  get revealColumns() {
    return this.props.revealColumns;
  }
  get maxRows() {
    return this.props.maxRows;
  }
  get metadataMcpServerId() {
    return this.props.metadataMcpServerId;
  }
  get metadataMcpProject() {
    return this.props.metadataMcpProject;
  }
  get isDefault() {
    return this.props.isDefault;
  }
  get hasPassword() {
    return this.props.password !== '';
  }
  get updatedAt() {
    return this.props.updatedAt;
  }

  /** Applies the given fields (`undefined` values are ignored) and bumps `updatedAt`. */
  update(changes: DatabaseConnectionChanges, now: number): void {
    const defined = Object.fromEntries(
      Object.entries(changes).filter(([, v]) => v !== undefined),
    ) as DatabaseConnectionChanges;
    this.props = { ...this.props, ...defined, updatedAt: Math.max(now, this.props.updatedAt + 1) };
  }

  setDefault(isDefault: boolean): void {
    this.props = { ...this.props, isDefault };
  }

  /** Everything the gateway needs; `version` changes on every edit so cached pools are replaced. */
  toParams(): PgConnectionParams {
    const p = this.props;
    return {
      id: p.id,
      version: p.updatedAt,
      host: p.host,
      port: p.port,
      database: p.database,
      user: p.user,
      password: p.password,
      sslMode: p.sslMode,
      statementTimeoutSec: p.statementTimeoutSec,
    };
  }

  toSnapshot(): DatabaseConnectionProps {
    return {
      ...this.props,
      schemas: [...this.props.schemas],
      sensitiveColumns: [...this.props.sensitiveColumns],
      revealColumns: [...this.props.revealColumns],
    };
  }
}
