import fs from 'node:fs/promises';
import path from 'node:path';
import type { LegacyPdfSource } from '../domain/render-ports';

/** PDFs cached on disk before the object store existed (`<dir>/<reportId>.pdf`). Ids, never paths. */
export class DiskLegacyPdfSource implements LegacyPdfSource {
  constructor(private readonly dir: string) {}

  private file(reportId: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(reportId)) throw new Error(`invalid report id: ${reportId}`);
    return path.join(this.dir, `${reportId}.pdf`);
  }

  async read(reportId: string): Promise<Uint8Array | null> {
    try {
      return await fs.readFile(this.file(reportId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(reportId: string): Promise<void> {
    await fs.rm(this.file(reportId), { force: true });
  }
}
