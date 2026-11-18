import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../../shared/infrastructure/db/client';
import { mcpServers } from '../../../shared/infrastructure/db/schema';
import type { SecretBox } from '../../../shared/infrastructure/crypto';
import type { McpServer, McpServerConfig, McpServerRepository } from '../domain/mcp-server';

type Row = typeof mcpServers.$inferSelect;

/** Persists MCP servers; the whole config (env vars, headers) is encrypted at rest. */
export class SqliteMcpServerRepository implements McpServerRepository {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
  ) {}

  async list(): Promise<McpServer[]> {
    return this.db
      .select()
      .from(mcpServers)
      .orderBy(asc(mcpServers.createdAt))
      .all()
      .map((r) => this.toDomain(r));
  }

  async findById(id: string): Promise<McpServer | null> {
    const row = this.db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
    return row ? this.toDomain(row) : null;
  }

  async findByName(name: string): Promise<McpServer | null> {
    const row = this.db.select().from(mcpServers).where(eq(mcpServers.name, name)).get();
    return row ? this.toDomain(row) : null;
  }

  async save(server: McpServer): Promise<void> {
    const row: Row = {
      id: server.id,
      name: server.name,
      transport: server.config.transport,
      configEnc: this.secrets.encrypt(JSON.stringify(server.config)),
      enabled: server.enabled,
      createdAt: server.createdAt,
    };
    this.db
      .insert(mcpServers)
      .values(row)
      .onConflictDoUpdate({ target: mcpServers.id, set: row })
      .run();
  }

  async delete(id: string): Promise<void> {
    this.db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
  }

  private toDomain(row: Row): McpServer {
    let config: McpServerConfig;
    try {
      config = JSON.parse(this.secrets.decrypt(row.configEnc)) as McpServerConfig;
    } catch {
      config =
        row.transport === 'stdio'
          ? { transport: 'stdio', command: '', args: [], env: {} }
          : { transport: 'http', url: 'http://invalid', headers: {} };
    }
    return { id: row.id, name: row.name, enabled: row.enabled, config, createdAt: row.createdAt };
  }
}
