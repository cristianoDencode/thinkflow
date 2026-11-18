/**
 * Architectural rules for the DDD layers of apps/server.
 *
 *   contexts/<ctx>/domain          pure model + ports (no infra, no frameworks)
 *   contexts/<ctx>/application     use cases (domain + ports only)
 *   contexts/<ctx>/infrastructure  adapters implementing ports (DB, HTTP, SDKs)
 *   contexts/<ctx>/interface       HTTP routes (Fastify)
 *   shared/kernel                  pure shared code (clock, ids, errors, ObjectStore port)
 *   shared/infrastructure/storage  ObjectStore adapters (the only place that may use the S3 SDK)
 *   src/app.ts                     composition root (may import anything)
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      comment: 'Domain must not depend on application, infrastructure or interface code.',
      severity: 'error',
      from: { path: '^apps/server/src/contexts/[^/]+/domain/' },
      to: {
        path: '^apps/server/src/(contexts/[^/]+/(application|infrastructure|interface)/|shared/(infrastructure|interface)/|app\\.ts)',
      },
    },
    {
      name: 'domain-no-frameworks',
      comment:
        'Domain may only use the shared contract package (types) and Node built-ins — no npm frameworks.',
      severity: 'error',
      from: { path: '^apps/server/src/contexts/[^/]+/domain/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer'],
        pathNot: '^packages/shared/',
      },
    },
    {
      name: 'application-no-infrastructure',
      comment: 'Use cases talk to ports, never to adapters or HTTP.',
      severity: 'error',
      from: { path: '^apps/server/src/contexts/[^/]+/application/' },
      to: {
        path: '^apps/server/src/(contexts/[^/]+/(infrastructure|interface)/|shared/interface/|app\\.ts)',
      },
    },
    {
      name: 'application-no-frameworks',
      severity: 'error',
      from: { path: '^apps/server/src/contexts/[^/]+/application/' },
      to: {
        path: 'node_modules/(fastify|@fastify|drizzle-orm|better-sqlite3|@modelcontextprotocol|@anthropic-ai|playwright-core|@aws-sdk|@smithy|unified|remark-|rehype-|pg|pg-cursor)',
      },
    },
    {
      name: 's3-sdk-only-in-storage',
      comment:
        'The S3 client (and its @smithy internals) stays behind the ObjectStore port: only the storage adapters may import it.',
      severity: 'error',
      from: { pathNot: '^apps/server/src/shared/infrastructure/storage/' },
      to: { path: 'node_modules/(@aws-sdk|@smithy)/' },
    },
    {
      name: 'kernel-is-pure',
      comment: 'shared/kernel is dependency-free: it may only import other kernel files.',
      severity: 'error',
      from: { path: '^apps/server/src/shared/kernel/' },
      to: { pathNot: '^apps/server/src/shared/kernel/' },
    },
    {
      name: 'shared-interface-no-contexts',
      comment: 'Shared HTTP routes receive context behavior through callbacks, never imports.',
      severity: 'error',
      from: { path: '^apps/server/src/shared/interface/' },
      to: { path: '^apps/server/src/contexts/' },
    },
    {
      name: 'infrastructure-not-from-interface-of-others',
      comment: 'Adapters must not reach into HTTP route modules.',
      severity: 'error',
      from: { path: '^apps/server/src/contexts/[^/]+/infrastructure/' },
      to: { path: '^apps/server/src/contexts/[^/]+/interface/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-test',
      severity: 'error',
      from: { pathNot: '^apps/server/tests/' },
      to: { path: '^apps/server/tests/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    exclude: { path: '(^|/)(dist|coverage|drizzle)/' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
