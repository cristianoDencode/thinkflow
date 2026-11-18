import path from 'node:path';
import { buildApp } from './app';
import { ConfigError, loadConfig, type AppConfig } from './shared/infrastructure/config';
import { resolveSecret } from './shared/infrastructure/crypto';
import { openDatabase } from './shared/infrastructure/db/client';

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const secret = resolveSecret(config.dataDir, config.secret);
  const handle = openDatabase(path.join(config.dataDir, 'thinkflow.sqlite'), config.migrationsDir);

  const isDev = process.env.NODE_ENV !== 'production';
  const { app } = await buildApp({
    config,
    db: handle.db,
    secret,
    logger: {
      level: config.logLevel,
      // defense in depth: credentials must never reach the logs
      redact: ['config.storage.secretAccessKey', 'config.storage.accessKeyId'],
      ...(isDev
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
  });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} recebido, encerrando…`);
    await app.close();
    handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Thinkflow rodando em http://localhost:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
