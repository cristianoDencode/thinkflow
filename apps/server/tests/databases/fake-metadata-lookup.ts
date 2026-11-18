import type {
  MetadataFieldMatch,
  MetadataLookup,
  MetadataTableMatch,
  MetadataTarget,
} from '../../src/contexts/databases/domain/ports';

/** Canned data dictionary; records every term it was asked about (they must be identifiers only). */
export class FakeMetadataLookup implements MetadataLookup {
  fieldTerms: string[] = [];
  tableTerms: string[] = [];
  targets: MetadataTarget[] = [];
  fields: MetadataFieldMatch[] = [];
  tables: MetadataTableMatch[] = [];
  down = false;

  async findFields(target: MetadataTarget, term: string): Promise<MetadataFieldMatch[]> {
    this.targets.push(target);
    this.fieldTerms.push(term);
    if (this.down) throw new Error('mcp fora do ar');
    return this.fields;
  }

  async findTables(target: MetadataTarget, term: string): Promise<MetadataTableMatch[]> {
    this.targets.push(target);
    this.tableTerms.push(term);
    if (this.down) throw new Error('mcp fora do ar');
    return this.tables;
  }

  async listProjects(): Promise<string[]> {
    return ['e-cidade'];
  }

  async listServers(): Promise<{ id: string; name: string }[]> {
    return [{ id: 'mcp-1', name: 'Mapeamento' }];
  }
}
