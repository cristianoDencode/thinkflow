import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NotebookLmLocalProfile } from '../../domain/ports';

const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The login the user already did with the CLI in a terminal:
 * `<home>/.notebooklm/profiles/<profile>/storage_state.json`. The path is built here from server
 * configuration only — never from client input. The file belongs to the user's CLI profile and is
 * only ever read.
 */
export class FsNotebookLmLocalProfile implements NotebookLmLocalProfile {
  private readonly file: string;

  constructor(opts: { homeDir?: string; profile?: string } = {}) {
    const profile = opts.profile ?? 'default';
    if (!PROFILE_RE.test(profile) || profile === '.' || profile === '..')
      throw new Error('Perfil do NotebookLM inválido');
    this.file = path.join(
      opts.homeDir ?? os.homedir(),
      '.notebooklm',
      'profiles',
      profile,
      'storage_state.json',
    );
  }

  exists(): boolean {
    try {
      return fs.statSync(this.file).isFile();
    } catch {
      return false;
    }
  }

  async read(): Promise<string | null> {
    try {
      return await fs.promises.readFile(this.file, 'utf8');
    } catch {
      return null;
    }
  }
}
