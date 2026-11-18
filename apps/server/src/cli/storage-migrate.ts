/**
 * `pnpm --filter @thinkflow/server storage:migrate [--dry-run]`
 * (production image: `node dist/storage-migrate.js [--dry-run]`)
 *
 * After switching STORAGE_DRIVER from `local` to `s3`, copies what is in the local object
 * directory (STORAGE_LOCAL_DIR or DATA_DIR/objects) to the bucket, and moves library uploads left
 * in DATA_DIR/library by older versions. Idempotent; never deletes the local objects.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateLegacyLibraryFiles } from '../contexts/library/infrastructure/object-document-file-store';
import { ConfigError, loadConfig } from '../shared/infrastructure/config';
import { copyObjects } from '../shared/infrastructure/storage/copy-objects';
import { createObjectStore } from '../shared/infrastructure/storage/create-object-store';
import { LocalObjectStore } from '../shared/infrastructure/storage/local-object-store';
import type { ObjectStore } from '../shared/kernel/object-store';
import { scopeObjectStore } from '../shared/kernel/scoped-object-store';

export interface StorageMigrateDeps {
  env: NodeJS.ProcessEnv;
  argv: string[];
  print: (line: string) => void;
  /** Replaces the target built from the config (tests). */
  target?: ObjectStore;
}

/** Returns the process exit code (0 = everything copied or already there). */
export async function runStorageMigrate(deps: StorageMigrateDeps): Promise<number> {
  const { print } = deps;
  const dryRun = deps.argv.includes('--dry-run');
  let config;
  let localDir: string;
  try {
    config = loadConfig(deps.env);
    // the same rules the app uses for the local driver (STORAGE_LOCAL_DIR / DATA_DIR/objects)
    const local = loadConfig({ ...deps.env, STORAGE_DRIVER: 'local' }).storage;
    localDir = local.driver === 'local' ? local.dir : path.join(config.dataDir, 'objects');
  } catch (err) {
    if (err instanceof ConfigError) {
      print(err.message);
      return 1;
    }
    throw err;
  }
  if (config.storage.driver !== 's3' && !deps.target) {
    print('STORAGE_DRIVER não é "s3": nada a migrar (os arquivos já estão no disco local).');
    return 1;
  }

  const source = new LocalObjectStore(localDir);
  const target = deps.target ?? createObjectStore(config.storage);
  try {
    const health = await target.check();
    if (!health.available) {
      print(`Destino indisponível (${target.location}): ${health.reason ?? 'sem resposta'}`);
      return 1;
    }
    print(`${dryRun ? '[simulação] ' : ''}Origem: ${source.location}`);
    print(`${dryRun ? '[simulação] ' : ''}Destino: ${target.location}`);

    const objects = await copyObjects(source, target, {
      prefix: config.storage.prefix,
      dryRun,
      onObject: (key, outcome, err) => {
        if (outcome === 'failed') {
          print(`  falha: ${key} (${err instanceof Error ? err.message : 'erro desconhecido'})`);
        }
      },
    });
    print(
      `Objetos: ${objects.copied} ${dryRun ? 'a copiar' : 'copiados'}, ${objects.skipped} já no destino, ${objects.failed} com falha.`,
    );

    const library = await migrateLegacyLibraryFiles(
      path.join(config.dataDir, 'library'),
      scopeObjectStore(target, config.storage.prefix, 'library'),
      {
        dryRun,
        onError: (err, key) =>
          print(`  falha: library/${key} (${err instanceof Error ? err.message : 'erro'})`),
      },
    );
    print(
      `Biblioteca (arquivos antigos): ${library.migrated} ${dryRun ? 'a mover' : 'movidos'}, ${library.skipped} ignorados, ${library.failed} com falha.`,
    );

    const failed = objects.failed + library.failed;
    if (!dryRun && failed === 0 && objects.copied + objects.skipped > 0) {
      print(
        `Pronto. Depois de conferir a aplicação com o S3, você pode apagar ${source.location}.`,
      );
    }
    return failed > 0 ? 1 : 0;
  } finally {
    if (!deps.target) await target.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStorageMigrate({
    env: process.env,
    argv: process.argv.slice(2),
    print: (line) => process.stdout.write(`${line}\n`),
  }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
