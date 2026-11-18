import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  historySettingsSchema,
  LIBRARY_LIMITS,
  librarySettingsSchema,
  reportSettingsSchema,
  type HealthDto,
  type LibrarySettings,
} from '@thinkflow/shared';
import { ChatService } from './contexts/chat/application/chat-service';
import { combineToolsets } from './contexts/chat/application/toolbox';
import type { AgentRunner } from './contexts/chat/domain/conversation';
import { ClaudeAgentRunner } from './contexts/chat/infrastructure/claude-agent-runner';
import { SqliteConversationRepository } from './contexts/chat/infrastructure/sqlite-conversation-repository';
import { DatabaseService } from './contexts/databases/application/database-service';
import { McpMetadataLookup } from './contexts/databases/infrastructure/mcp-metadata-lookup';
import type { PgGateway } from './contexts/databases/domain/ports';
import { PgPoolGateway } from './contexts/databases/infrastructure/pg-gateway';
import { SqliteColumnRuleRepository } from './contexts/privacy/infrastructure/sqlite-column-rule-repository';
import { PrivacyFirewall } from './contexts/privacy/application/privacy-firewall';
import {
  createPresidioSpans,
  probePresidio,
} from './contexts/privacy/infrastructure/presidio-client';
import { SqliteVaultStore } from './contexts/privacy/infrastructure/sqlite-vault';
import { SqliteDatabaseConnectionRepository } from './contexts/databases/infrastructure/sqlite-database-repository';
import { registerDatabaseRoutes } from './contexts/databases/interface/http/database-routes';
import { OneDriveService } from './contexts/onedrive/application/onedrive-service';
import { HttpOneDriveGraph } from './contexts/onedrive/infrastructure/graph-client';
import { HttpMicrosoftOAuth } from './contexts/onedrive/infrastructure/microsoft-oauth';
import { SqliteOneDriveStore } from './contexts/onedrive/infrastructure/sqlite-onedrive-store';
import { registerOneDriveRoutes } from './contexts/onedrive/interface/http/onedrive-routes';
import { registerChatRoutes } from './contexts/chat/interface/http/chat-routes';
import { ConnectionService } from './contexts/connections/application/connection-service';
import { HttpConnectionProbe } from './contexts/connections/infrastructure/http-connection-probe';
import { SqliteConnectionUsageReader } from './contexts/connections/infrastructure/sqlite-connection-usage';
import { SqliteQuotaStore } from './contexts/connections/infrastructure/sqlite-quota-store';
import type { FetchFn } from './contexts/connections/infrastructure/provider-http';
import {
  SqliteComboRepository,
  SqliteConnectionRepository,
} from './contexts/connections/infrastructure/sqlite-repositories';
import { registerConnectionRoutes } from './contexts/connections/interface/http/connection-routes';
import { GatewayService } from './contexts/gateway/application/gateway-service';
import { registerV1Routes } from './contexts/gateway/interface/http/v1-routes';
import { AuthService } from './contexts/identity/application/auth-service';
import {
  SqliteApiKeyRepository,
  SqliteSessionRepository,
  SqliteUserRepository,
  nodeCredentialHasher,
} from './contexts/identity/infrastructure/sqlite-identity-repositories';
import { registerAuthRoutes, requireSession } from './contexts/identity/interface/http/auth-routes';
import { IngestionQueue } from './contexts/library/application/ingestion-queue';
import { LibraryService } from './contexts/library/application/library-service';
import { LocalEngine } from './contexts/library/application/local-engine';
import { NotebookLmEngine } from './contexts/library/application/notebooklm-engine';
import { NotebookLmSettingsService } from './contexts/library/application/notebooklm-settings-service';
import type {
  NotebookLmAccountProbe,
  NotebookLmConfigStore,
  NotebookLmGateway,
  NotebookLmLocalProfile,
  NotebookLmLoginRunner,
  LibraryUsageRecorder,
  OcrEngine,
} from './contexts/library/domain/ports';
import {
  ObjectDocumentFileStore,
  migrateLegacyLibraryFiles,
  type LegacyMigrationResult,
} from './contexts/library/infrastructure/object-document-file-store';
import { CompositeExtractor } from './contexts/library/infrastructure/extractors/composite-extractor';
import { RouterVisionOcr } from './contexts/library/infrastructure/ocr/router-vision-ocr';
import { TesseractOcr } from './contexts/library/infrastructure/ocr/tesseract-ocr';
import { CliAccountLimitsProbe } from './contexts/library/infrastructure/notebooklm/account-limits-probe';
import { CliLoginRunner } from './contexts/library/infrastructure/notebooklm/cli-login-runner';
import { FsNotebookLmLocalProfile } from './contexts/library/infrastructure/notebooklm/fs-local-profile';
import {
  NotebookLmCliGateway,
  sweepNotebookLmScratch,
} from './contexts/library/infrastructure/notebooklm/notebooklm-cli-gateway';
import {
  SettingsNotebookLmConfigStore,
  defaultNotebookLmCommand,
} from './contexts/library/infrastructure/notebooklm/settings-notebooklm-config-store';
import { SqliteChunkIndex } from './contexts/library/infrastructure/sqlite-chunk-index';
import { SqliteLibraryRepository } from './contexts/library/infrastructure/sqlite-library-repository';
import { registerLibraryRoutes } from './contexts/library/interface/http/library-routes';
import { registerNotebookLmRoutes } from './contexts/library/interface/http/notebooklm-routes';
import { McpService } from './contexts/mcp/application/mcp-service';
import type { McpGateway } from './contexts/mcp/domain/mcp-server';
import { McpClientPool } from './contexts/mcp/infrastructure/mcp-client-pool';
import { SqliteMcpServerRepository } from './contexts/mcp/infrastructure/sqlite-mcp-repository';
import { registerMcpRoutes } from './contexts/mcp/interface/http/mcp-routes';
import { DiagramService } from './contexts/reports/application/diagram-service';
import { ReportArtifactJanitor } from './contexts/reports/application/report-artifact-janitor';
import { ReportArtifactSync } from './contexts/reports/application/report-artifact-sync';
import { ReportDocumentBuilder } from './contexts/reports/application/report-document';
import { PresetService } from './contexts/reports/application/preset-service';
import { ReportIntake } from './contexts/reports/application/report-intake';
import { ReportPipeline } from './contexts/reports/application/report-pipeline';
import { ReportRunner } from './contexts/reports/application/report-runner';
import { ReportService } from './contexts/reports/application/report-service';
import type { Sleep } from './contexts/reports/application/llm';
import { TemplateAssistant } from './contexts/reports/application/template-assistant';
import { TemplateService } from './contexts/reports/application/template-service';
import type { DiagramRenderer, PdfRenderer } from './contexts/reports/domain/render-ports';
import { ChromiumBrowser } from './contexts/reports/infrastructure/chromium/chromium-browser';
import { ChromiumDiagramRenderer } from './contexts/reports/infrastructure/chromium/chromium-diagram-renderer';
import { ChromiumPdfRenderer } from './contexts/reports/infrastructure/chromium/chromium-pdf-renderer';
import { DiskLegacyPdfSource } from './contexts/reports/infrastructure/legacy-pdf-source';
import { ObjectReportArtifactStore } from './contexts/reports/infrastructure/object-report-artifact-store';
import { RemarkHtmlRenderer } from './contexts/reports/infrastructure/markdown/remark-html-renderer';
import { SqliteReportRepository } from './contexts/reports/infrastructure/sqlite-report-repository';
import { SqliteTemplateRepository } from './contexts/reports/infrastructure/sqlite-template-repository';
import { registerDiagramRoutes } from './contexts/reports/interface/http/diagram-routes';
import { registerReportRoutes } from './contexts/reports/interface/http/report-routes';
import { registerTemplateRoutes } from './contexts/reports/interface/http/template-routes';
import { UsageService } from './contexts/usage/application/usage-service';
import { SqliteUsageRepository } from './contexts/usage/infrastructure/sqlite-usage-repository';
import { registerUsageRoutes } from './contexts/usage/interface/http/usage-routes';
import { RouteChatRequest } from './contexts/routing/application/route-chat-request';
import { HttpProviderExecutor } from './contexts/routing/infrastructure/http-provider-executor';
import { SqliteRequestLogRepository } from './contexts/routing/infrastructure/sqlite-request-log-repository';
import { systemClock, type Clock } from './shared/kernel/clock';
import { uuidGenerator } from './shared/kernel/ids';
import type { ObjectStore } from './shared/kernel/object-store';
import { scopeObjectStore } from './shared/kernel/scoped-object-store';
import { canOpenWindow } from './shared/infrastructure/display';
import { TestSessionService } from './contexts/testing/application/test-session-service';
import { DocumentService } from './contexts/testing/application/document-service';
import { EvidenceService } from './contexts/testing/application/evidence-service';
import { RecordingService } from './contexts/testing/application/recording-service';
import { RunService } from './contexts/testing/application/run-service';
import { DownloadService } from './contexts/testing/application/download-service';
import { PlaywrightRunner } from './contexts/testing/infrastructure/playwright/playwright-runner';
import type {
  DisplaySupport,
  RecorderBrowser,
  TestRunner,
  TestSessionRepository,
} from './contexts/testing/domain/ports';
import type { ScreenSettler } from './contexts/testing/domain/settle';
import { migrateLegacyStepImages } from './contexts/testing/infrastructure/migrate-step-images';
import { PlaywrightRecorderBrowser } from './contexts/testing/infrastructure/playwright/playwright-recorder';
import { ObjectTestImageStore } from './contexts/testing/infrastructure/object-test-image-store';
import { SqliteTestRepository } from './contexts/testing/infrastructure/sqlite-test-repository';
import { registerTestRoutes } from './contexts/testing/interface/http/test-routes';
import { CtDocumentService } from './contexts/testing/application/ct-document-service';
import { createCtRenderers } from './contexts/testing/infrastructure/ct/ct-renderers';
import { registerCtRoutes } from './contexts/testing/interface/http/ct-routes';
import { CtAssistant } from './contexts/testing/application/ct-assistant';
import { CtAssistantToolsAdapter } from './contexts/testing/infrastructure/ct-assistant-tools';
import { registerCtAssistantRoutes } from './contexts/testing/interface/http/ct-assistant-routes';
import { CtLayoutAssistant } from './contexts/testing/application/ct-layout-assistant';
import { CtModelService } from './contexts/testing/application/ct-model-service';
import { CT_SAMPLE_DOCUMENT } from './contexts/testing/domain/ct-model';
import { SqliteCtModelRepository } from './contexts/testing/infrastructure/sqlite-ct-model-repository';
import { registerCtModelRoutes } from './contexts/testing/interface/http/ct-model-routes';
import { PrototypeService } from './contexts/prototypes/application/prototype-service';
import { ObjectPrototypeStore } from './contexts/prototypes/infrastructure/object-prototype-store';
import {
  SqlitePrototypeRepository,
  SqliteSessionLookup,
} from './contexts/prototypes/infrastructure/sqlite-prototype-repository';
import { PrototypeRenderService } from './contexts/prototypes/application/prototype-render-service';
import { PrototypeSceneService } from './contexts/prototypes/application/prototype-scene-service';
import { PrototypeThumbnails } from './contexts/prototypes/application/prototype-thumbnails';
import { ChromiumPrototypeRenderer } from './contexts/prototypes/infrastructure/chromium-prototype-renderer';
import type { PrototypeRenderer } from './contexts/prototypes/domain/ports';
import { PrototypeDocumentSink } from './contexts/testing/application/prototype-document-sink';
import { registerPrototypeRoutes } from './contexts/prototypes/interface/http/prototype-routes';
import { PrototypeAssistant } from './contexts/prototypes/application/prototype-assistant';
import { registerPrototypeAssistantRoutes } from './contexts/prototypes/interface/http/prototype-assistant-routes';
import type { AppConfig } from './shared/infrastructure/config';
import { SecretBox } from './shared/infrastructure/crypto';
import type { Db } from './shared/infrastructure/db/client';
import { SettingsStore } from './shared/infrastructure/settings-store';
import {
  createObjectStore,
  prepareObjectStore,
} from './shared/infrastructure/storage/create-object-store';
import { StorageMonitor } from './shared/infrastructure/storage/storage-monitor';
import { registerErrorHandler } from './shared/interface/http/error-handler';
import { registerSettingsRoutes } from './shared/interface/http/settings-routes';
import { registerStorageRoutes } from './shared/interface/http/storage-routes';

export const VERSION = '0.1.0';

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  secret: string;
  /** Overrides for tests. */
  fetchFn?: FetchFn;
  mcpGateway?: McpGateway;
  /** Replaces the Postgres gateway of "Dados com IA"; tests inject a fake. */
  pgGateway?: PgGateway;
  agentRunner?: AgentRunner;
  clock?: Clock;
  /** Replaces the object store built from `config.storage`; tests inject a MemoryObjectStore. */
  objectStore?: ObjectStore;
  /** Where original library uploads are stored (default: DATA_DIR/library). */
  libraryDir?: string;
  /** Replaces the local (Tesseract) OCR engine; tests use a fake. */
  ocrEngine?: OcrEngine;
  /** Replaces the CLI-backed NotebookLM gateway (tests use an in-memory fake). */
  notebookLmGateway?: NotebookLmGateway;
  /** Replaces the probe that reads the account's NotebookLM limits (tests use a fake). */
  notebookLmProbe?: NotebookLmAccountProbe;
  /** Knobs of the NotebookLM CLI integration; tests point everything at temp dirs and the fake CLI. */
  notebookLm?: {
    /** NOTEBOOKLM_HOME and scratch files (default: DATA_DIR/notebooklm). */
    workDir?: string;
    /** Where the CLI's own login lives (`<home>/.notebooklm/...`; default: the OS home). */
    homeDir?: string;
    /** Environment the CLI inherits from (default: process.env); also decides if a display exists. */
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    isContainer?: () => boolean;
    /** Pause between CLI processes (default 1500 ms). */
    minGapMs?: number;
    loginTimeoutSec?: number;
    /** How long a document may take to become ready in NotebookLM (default 300 s). */
    syncTimeoutMs?: number;
    /** Length of one `source wait` call (default 20 s). */
    waitSliceMs?: number;
    loginRunner?: NotebookLmLoginRunner;
    localProfile?: NotebookLmLocalProfile;
  };
  /** Knobs of the report generation; tests make the provider wait instant. */
  reports?: {
    /** Resume unfinished reports at boot (default true). */
    autoStart?: boolean;
    /** Replaces the timer used while waiting for provider limits. */
    sleep?: Sleep;
    /** Replaces the Chromium Mermaid validator; tests use a fake so the suite needs no browser. */
    diagramRenderer?: DiagramRenderer;
    /** Replaces the Chromium PDF renderer. */
    pdfRenderer?: PdfRenderer;
    /** Where PDFs were cached before the object store (default: DATA_DIR/reports); read by the backfill. */
    dataDir?: string;
  };
  /** Knobs of the screen prototypes; tests replace the Chromium PNG renderer. */
  prototypes?: {
    renderer?: PrototypeRenderer;
    /** Quiet time before the background thumbnail render of a new version (default 2 s). */
    thumbnailDebounceMs?: number;
  };
  /** Knobs of the test sessions ("Testes"); tests replace the display check and the browser. */
  tests?: {
    display?: DisplaySupport;
    recorder?: RecorderBrowser;
    runner?: TestRunner;
    /** Waits for the screen to settle before a print (default: the real, browser-driven wait). */
    settler?: ScreenSettler;
  };
  logger?: FastifyServerOptions['logger'];
}

export interface AppContainer {
  auth: AuthService;
  connections: ConnectionService;
  router: RouteChatRequest;
  mcp: McpService;
  chat: ChatService;
  databases: DatabaseService;
  /** OneDrive (personal account): uploads new .docx files and opens them in Word Online. */
  onedrive: OneDriveService;
  gateway: GatewayService;
  settings: SettingsStore;
  mcpGateway: McpGateway;
  /** Generic object storage for generated documents (local, S3/MinIO or memory). */
  storage: {
    store: ObjectStore;
    monitor: StorageMonitor;
    /** Uploads the generated reports (staging column -> object store). */
    sync: {
      /** Resolves when no upload is running or queued (tests). */
      whenIdle(): Promise<void>;
      /** Retries every pending upload now, ignoring the backoff, and moves legacy PDFs. */
      flushAll(): Promise<void>;
      /** The boot backfill (idempotent). */
      backfill(): Promise<void>;
    };
    /** Removes orphaned documents and superseded versions. */
    janitor: { runOnce(): Promise<{ removedReports: number; removedVersions: number }> };
  };
  library: {
    service: LibraryService;
    /** Resolves when the ingestion queue has nothing left to process (tests). */
    whenIdle(): Promise<void>;
    /** Moves uploads left in DATA_DIR/library by older versions into the store (boot does it too). */
    migrateLegacyFiles(): Promise<LegacyMigrationResult>;
  };
  notebookLm: {
    settings: NotebookLmSettingsService;
    gateway: NotebookLmGateway;
    config: NotebookLmConfigStore;
  };
  reports: {
    templates: TemplateService;
    service: ReportService;
    runner: {
      /** Resolves when no report job is queued or running (tests). */
      whenIdle(): Promise<void>;
    };
  };
  tests: {
    sessions: TestSessionService;
    recording: RecordingService;
    evidences: EvidenceService;
    runs: RunService;
    repo: TestSessionRepository;
  };
  prototypes: PrototypeService;
}

/** Composition root: wires repositories, services and HTTP routes. */
export async function buildApp(
  options: BuildAppOptions,
): Promise<{ app: FastifyInstance; container: AppContainer }> {
  const { config, db } = options;
  const clock = options.clock ?? systemClock;
  const ids = uuidGenerator;
  const secrets = new SecretBox(options.secret);
  const settings = new SettingsStore(db);

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024 * 1024 });

  // Object storage for generated documents. Built here (not lazily) so contexts can receive it.
  const ownsObjectStore = !options.objectStore;
  const objectStore =
    options.objectStore ??
    createObjectStore(config.storage, {
      logger: app.log,
      rootUser: process.env.MINIO_ROOT_USER,
    });
  const storageMonitor = new StorageMonitor(objectStore, { clock, logger: app.log });

  const connectionRepo = new SqliteConnectionRepository(db, secrets);
  const comboRepo = new SqliteComboRepository(db);
  const logRepo = new SqliteRequestLogRepository(db);

  const auth = new AuthService({
    users: new SqliteUserRepository(db),
    sessions: new SqliteSessionRepository(db),
    apiKeys: new SqliteApiKeyRepository(db),
    hasher: nodeCredentialHasher,
    clock,
    ids,
  });

  const probe = new HttpConnectionProbe(options.fetchFn);
  const quotaStore = new SqliteQuotaStore(db);
  const connections = new ConnectionService({
    connections: connectionRepo,
    combos: comboRepo,
    probe,
    quota: quotaStore,
    usage: new SqliteConnectionUsageReader(db),
    clock,
    ids,
  });

  const usage = new UsageService({
    repo: new SqliteUsageRepository(db),
    budget: {
      getMonthlyTokens: () => settings.get<number>('usageMonthlyBudget', 0),
      setMonthlyTokens: (tokens) => settings.set('usageMonthlyBudget', tokens),
    },
    clock,
  });

  // Privacy firewall: personal data is tokenized before any request reaches a provider. Vaults
  // are per conversation/report (they die with their owner) and per /v1 client (in memory).
  const privacyVaults = new SqliteVaultStore(db, secrets, clock);
  // Optional Presidio sidecar: the URL (setting, else PRIVACY_PRESIDIO_URL) is read per call, so
  // changing it in the settings page takes effect immediately.
  const presidioUrl = () => settings.privacy().presidioUrl.trim() || config.presidioUrl || '';
  let lastDegradedWarning = 0;
  const privacyFirewall = new PrivacyFirewall({
    vaults: privacyVaults,
    settings: () => settings.privacy(),
    extraSpans: async (text) => {
      const url = presidioUrl();
      if (!url) return [];
      const detect = createPresidioSpans({
        url,
        minScore: settings.privacy().minScore,
        fetch: options.fetchFn,
      });
      return detect(text);
    },
    onDegraded: () => {
      const now = clock.now();
      if (now - lastDegradedWarning < 60_000) return;
      lastDegradedWarning = now;
      app.log.warn('Presidio indisponível: protegendo só com os detectores nativos');
    },
  });

  const router = new RouteChatRequest({
    connections: connectionRepo,
    combos: comboRepo,
    aliases: settings,
    executor: new HttpProviderExecutor(options.fetchFn, { quota: quotaStore }),
    logs: logRepo,
    discovery: probe,
    quota: quotaStore,
    privacy: privacyFirewall,
    usage,
    capacity: {
      load: () => settings.get('capacityBook', {}),
      save: (snapshot) => settings.set('capacityBook', snapshot),
    },
    clock,
    ids,
  });

  const mcpGateway = options.mcpGateway ?? new McpClientPool();
  const mcpServers = new SqliteMcpServerRepository(db, secrets);
  const mcp = new McpService({
    servers: mcpServers,
    gateway: mcpGateway,
    clock,
    ids,
  });

  const libraryRepo = new SqliteLibraryRepository(db);
  const chunkIndex = new SqliteChunkIndex(db);
  // Original uploads go to the ObjectStore (`library/`); DATA_DIR/library only holds files from
  // older versions until the boot migration moves them (they are read as a fallback meanwhile).
  const legacyLibraryDir = options.libraryDir ?? path.join(config.dataDir, 'library');
  const libraryObjects = scopeObjectStore(objectStore, config.storage.prefix, 'library');
  const fileStore = new ObjectDocumentFileStore({
    store: libraryObjects,
    legacyDir: legacyLibraryDir,
    health: () => storageMonitor.status(),
    maxBytes: LIBRARY_LIMITS.maxFileBytes,
  });
  const librarySettings = {
    get: (): LibrarySettings => librarySettingsSchema.parse(settings.get('librarySettings', {})),
    set: (value: LibrarySettings) => settings.set('librarySettings', value),
  };
  const nlm = options.notebookLm ?? {};
  const nlmHome = nlm.homeDir ?? os.homedir();
  const nlmWorkDir = nlm.workDir ?? path.join(config.dataDir, 'notebooklm');
  sweepNotebookLmScratch(nlmWorkDir);
  const nlmConfig = new SettingsNotebookLmConfigStore(settings, secrets, () =>
    defaultNotebookLmCommand(nlmHome),
  );
  const nlmGateway =
    options.notebookLmGateway ??
    new NotebookLmCliGateway({
      config: nlmConfig,
      workDir: nlmWorkDir,
      env: nlm.env,
      minGapMs: nlm.minGapMs,
      log: (message) => app.log.warn(message),
    });
  const libraryUsage: LibraryUsageRecorder = {
    record: (e) =>
      usage.record({
        at: clock.now(),
        source: e.source,
        providerId: e.providerId,
        model: e.model,
        success: e.success,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        estimated: true,
      }),
  };
  // Local OCR is the default (private, offline); vision goes through the router (opt-in) and falls
  // back to local OCR when the provider fails.
  const localOcr = new TesseractOcr({
    tessdataDir: path.join(config.dataDir, 'tessdata'),
    languages: () => librarySettings.get().ocrLanguages,
    usage: libraryUsage,
    log: (message) => app.log.info(message),
  });
  const visionOcr = new RouterVisionOcr({ router, model: () => librarySettings.get().ocrModel });
  const localEngine = options.ocrEngine ?? localOcr;
  const localSearch = new LocalEngine({ index: chunkIndex, repo: libraryRepo });
  // Experimental: questions go to the library's NotebookLM notebook; the local index is the fallback.
  const notebookLmEngine = new NotebookLmEngine({
    repo: libraryRepo,
    files: fileStore,
    gateway: nlmGateway,
    config: nlmConfig,
    local: localSearch,
    usage: libraryUsage,
    clock,
    onError: (err) => app.log.warn({ err }, 'notebooklm engine failed'),
    syncTimeoutMs: nlm.syncTimeoutMs,
    waitSliceMs: nlm.waitSliceMs,
  });
  const libraryEngines = { local: localSearch, notebooklm: notebookLmEngine };
  const ingestion = new IngestionQueue({
    repo: libraryRepo,
    index: chunkIndex,
    files: fileStore,
    engines: libraryEngines,
    extractor: new CompositeExtractor({
      ocr: () => {
        const mode = librarySettings.get().ocr;
        return mode === 'off' ? null : mode === 'vision' ? visionOcr : localEngine;
      },
      ocrFallback: () => (librarySettings.get().ocr === 'vision' ? localEngine : null),
      onWarning: (message) => app.log.warn(message),
    }),
    clock,
    onError: (err, doc) => app.log.error({ err, documentId: doc.id }, 'library ingestion failed'),
  });
  const library = new LibraryService({
    repo: libraryRepo,
    index: chunkIndex,
    files: fileStore,
    ingestion,
    engines: libraryEngines,
    notebookLm: notebookLmEngine,
    clock,
    ids,
    onError: (err) => app.log.warn({ err }, 'library engine hook failed'),
  });

  const notebookLmSettings = new NotebookLmSettingsService({
    config: nlmConfig,
    gateway: nlmGateway,
    login:
      nlm.loginRunner ??
      new CliLoginRunner({
        workDir: nlmWorkDir,
        env: nlm.env,
        platform: nlm.platform,
        isContainer: nlm.isContainer,
      }),
    localProfile: nlm.localProfile ?? new FsNotebookLmLocalProfile({ homeDir: nlmHome }),
    probe:
      options.notebookLmProbe ??
      new CliAccountLimitsProbe({
        config: nlmConfig,
        workDir: nlmWorkDir,
        env: nlm.env,
        log: (message) => app.log.warn(message),
      }),
    clock,
    loginTimeoutSec: nlm.loginTimeoutSec,
    onError: (err) => app.log.warn({ err }, 'notebooklm login failed'),
  });

  const localHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const selfBaseUrl = `http://${localHost}:${config.port}`;
  const internalKey = auth.issueInternalKey();
  const defaultAgentCwd = () => settings.get<string>('agentDefaultCwd', '') || os.homedir();

  const pgGateway = options.pgGateway ?? new PgPoolGateway();
  const databases = new DatabaseService({
    repo: new SqliteDatabaseConnectionRepository(db, secrets),
    gateway: pgGateway,
    clock,
    ids,
    rules: new SqliteColumnRuleRepository(db, clock, ids),
    // optional data dictionary (MCP) to suggest names when the AI's SQL names something that does not exist
    metadata: new McpMetadataLookup({ servers: mcpServers, gateway: mcpGateway }),
  });

  const onedriveFetch: FetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  const onedrive = new OneDriveService({
    store: new SqliteOneDriveStore(db, secrets, clock),
    oauth: new HttpMicrosoftOAuth(onedriveFetch),
    graph: new HttpOneDriveGraph(onedriveFetch),
    clock,
  });

  const chat = new ChatService({
    conversations: new SqliteConversationRepository(db),
    vaults: privacyVaults,
    router,
    mcp,
    agent:
      options.agentRunner ??
      new ClaudeAgentRunner({ baseUrl: () => selfBaseUrl, apiKey: () => internalKey }),
    clock,
    ids,
    defaultAgentCwd,
    historySettings: () => historySettingsSchema.parse(settings.get('chatHistory', {})),
    inputLimitHint: (model) => router.inputLimitHint(model),
    library: { chatTools: (id, opts) => library.chatTools(id, opts) },
    data: databases,
    // resolved lazily: the report services are created right after the chat service
    presets: { chatTools: (preset, ctx) => presetService.chatTools(preset, ctx) },
  });

  // One headless Chromium for diagrams and PDF (started on first use); tests inject fakes.
  const chromiumBrowser = new ChromiumBrowser({
    executablePath: () =>
      reportSettingsSchema.parse(settings.get('reportSettings', {})).chromiumPath,
  });
  const diagramRenderer =
    options.reports?.diagramRenderer ?? new ChromiumDiagramRenderer(chromiumBrowser);
  const pdfRenderer = options.reports?.pdfRenderer ?? new ChromiumPdfRenderer(chromiumBrowser);
  const markdownToHtml = new RemarkHtmlRenderer();

  const diagrams = new DiagramService({
    router,
    renderer: diagramRenderer,
    repairModel: () =>
      settings.get<{ repairModel?: string }>('reportSettings', {}).repairModel?.trim() ||
      historySettingsSchema.parse(settings.get('chatHistory', {})).summaryModel,
    onRepaired: (messageId, hash, code) => chat.rememberDiagramRepair(messageId, hash, code),
    now: () => clock.now(),
  });

  const templates = new TemplateService({ repo: new SqliteTemplateRepository(db), clock, ids });
  await templates.ensureBuiltIns();
  const templateAssistant = new TemplateAssistant({ router });

  const reportSettings = {
    get: () => reportSettingsSchema.parse(settings.get('reportSettings', {})),
    set: (value: ReturnType<typeof reportSettingsSchema.parse>) =>
      settings.set('reportSettings', value),
  };
  const reportRepo = new SqliteReportRepository(db);
  const reportArtifacts = new ObjectReportArtifactStore(objectStore, config.storage.prefix);
  const legacyPdfSource = new DiskLegacyPdfSource(
    options.reports?.dataDir ?? path.join(config.dataDir, 'reports'),
  );
  const reportSync = new ReportArtifactSync({
    repo: reportRepo,
    artifacts: reportArtifacts,
    legacyPdf: legacyPdfSource,
    clock,
    checkAvailable: async () => (await storageMonitor.status()).available,
    onError: (err, info) => app.log.warn({ err, ...info }, 'report storage sync failed'),
  });
  const reportJanitor = new ReportArtifactJanitor({
    repo: reportRepo,
    artifacts: reportArtifacts,
    clock,
    onError: (err, action) => app.log.warn({ err, action }, 'report storage cleanup failed'),
  });
  const reportConversations = new SqliteConversationRepository(db);
  const reportDocuments = new ReportDocumentBuilder({ markdown: markdownToHtml, diagrams });
  const reportPipeline = new ReportPipeline({
    repo: reportRepo,
    router,
    diagrams,
    documents: reportDocuments,
    markdown: markdownToHtml,
    research: {
      // unattended research: only the template's MCP servers, plus the connected library
      open: async (opts) => {
        const mcpToolset = opts.useMcp
          ? await mcp.enabledToolset({ servers: opts.mcpServers })
          : null;
        const lib = opts.libraryId
          ? await library.chatTools(opts.libraryId, {
              maxOutputChars: opts.maxOutputChars,
              maxCalls: opts.libraryMaxCalls,
              maxTotalChars: opts.libraryMaxTotalChars,
              remoteMaxCalls: opts.remoteLibraryMaxCalls,
            })
          : null;
        const box = combineToolsets(
          mcpToolset && mcpToolset.tools.length > 0 ? mcpToolset : null,
          lib,
        );
        if (!box) return null;
        return {
          defs: box.defs,
          call: (name, args, signal) => box.call(name, args, signal),
          libraryToolNames: new Set(lib?.tools.map((t) => t.name) ?? []),
          libraryName: lib?.libraryName ?? null,
          systemNote: lib?.systemNote ?? '',
          mcpErrors: mcpToolset?.errors ?? [],
        };
      },
    },
    settings: () => reportSettings.get(),
    contextBudget: () =>
      historySettingsSchema.parse(settings.get('chatHistory', {})).contextBudgetTokens,
    inputLimitHint: (model) => router.inputLimitHint(model),
    clock,
    ids,
    ...(options.reports?.sleep ? { sleep: options.reports.sleep } : {}),
    onError: (err, reportId) => app.log.error({ err, reportId }, 'report job failed'),
    onAssembled: (id) => reportSync.kick(id),
  });
  const reportRunner = new ReportRunner({
    repo: reportRepo,
    executor: reportPipeline,
    clock,
    onError: (err, reportId) => app.log.error({ err, reportId }, 'report runner failed'),
  });
  const reportService = new ReportService({
    repo: reportRepo,
    runner: reportRunner,
    templates,
    conversations: {
      read: async (id) => {
        const conversation = await reportConversations.findById(id);
        if (!conversation) return null;
        return {
          summary: conversation.summary?.text ?? null,
          messages: await reportConversations.messages(id),
        };
      },
    },
    intake: new ReportIntake({ router }),
    settings: reportSettings,
    clock,
    ids,
    // a report's privacy tokens die with it
    onDeleted: (report) => privacyVaults.deleteScope(report.id),
    onAssembled: (id) => reportSync.kick(id),
    onStorageError: (err, action, reportId) =>
      app.log.warn({ err, action, reportId }, 'report storage problem'),
    rendering: {
      documents: reportDocuments,
      pdf: pdfRenderer,
      diagrams: diagramRenderer,
      artifacts: reportArtifacts,
      legacyPdf: legacyPdfSource,
      library: {
        addMarkdown: async (libraryId, name, text) => {
          const res = await library.addDocuments(libraryId, [
            { name, mimeType: 'text/markdown', bytes: Buffer.from(text, 'utf8') },
          ]);
          const accepted = res.accepted[0];
          if (accepted) return { documentId: accepted.id, name: accepted.name };
          return { rejected: res.rejected[0]?.reason ?? 'A biblioteca não aceitou o documento.' };
        },
      },
    },
  });
  const presetService = new PresetService({ templates, reports: reportService });

  const gateway = new GatewayService(router, connections);

  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: LIBRARY_LIMITS.maxFileBytes,
      files: LIBRARY_LIMITS.maxFilesPerUpload,
      fields: 5,
      parts: 20,
    },
  });
  registerErrorHandler(app);

  const startedAt = Date.now();
  app.get('/api/health', async (): Promise<HealthDto> => ({
    status: 'ok',
    version: VERSION,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  }));

  const guard = requireSession(auth);
  registerAuthRoutes(app, auth, { cookieSecure: config.cookieSecure });
  registerConnectionRoutes(app, { service: connections, logs: logRepo, guard });
  registerMcpRoutes(app, { service: mcp, guard });
  registerChatRoutes(app, { service: chat, guard });
  registerDatabaseRoutes(app, { service: databases, guard });
  registerOneDriveRoutes(app, { service: onedrive, guard });
  registerSettingsRoutes(app, {
    settings,
    guard,
    publicBaseUrl: `http://localhost:${config.port}`,
    defaultAgentCwd,
    probePresidio: () => probePresidio(presidioUrl(), options.fetchFn),
  });
  // Test sessions ("Testes"): recorded browser sessions, annotated evidence, replays, documents.
  // older versions kept loose evidences and per-step thumbnails: they become step images/steps
  migrateLegacyStepImages(db);
  const testRepo = new SqliteTestRepository(db, secrets);
  const testImages = new ObjectTestImageStore(
    scopeObjectStore(objectStore, config.storage.prefix, 'tests'),
    () => storageMonitor.status(),
  );
  // Screen prototypes ("Protótipos"): captured from the recorded browser, edited in the web app
  const prototypeRepo = new SqlitePrototypeRepository(db);
  const prototypeFiles = new ObjectPrototypeStore(
    scopeObjectStore(objectStore, config.storage.prefix, 'prototypes'),
    () => storageMonitor.status(),
  );
  // the PNG of a prototype is refreshed in the background after each new version (see below)
  const prototypeHooks: { thumbnails?: PrototypeThumbnails } = {};
  const prototypes = new PrototypeService({
    repo: prototypeRepo,
    files: prototypeFiles,
    sessions: new SqliteSessionLookup(db),
    clock,
    ids,
    onError: (err) => app.log.warn({ err }, 'prototype storage failed'),
    onVersionSaved: (id) => prototypeHooks.thumbnails?.schedule(id),
  });
  const testDisplay = options.tests?.display ?? { canOpenWindow: () => canOpenWindow() };
  const testDownloads = new DownloadService({
    repo: testRepo,
    images: testImages,
    clock,
    ids,
    onError: (err) => app.log.warn({ err }, 'test download failed'),
  });
  const testRecording = new RecordingService({
    repo: testRepo,
    images: testImages,
    downloads: testDownloads,
    prototypes: { capture: (input) => prototypes.createFromCapture(input) },
    browser:
      options.tests?.recorder ??
      new PlaywrightRecorderBrowser({
        executablePath: () =>
          reportSettingsSchema.parse(settings.get('reportSettings', {})).chromiumPath,
      }),
    display: testDisplay,
    clock,
    ids,
    isBusy: (id) => testRuns.isRunning(id),
    ...(options.tests?.settler ? { settler: options.tests.settler } : {}),
    onError: (err) => app.log.warn({ err }, 'test recording failed'),
  });
  const testRuns = new RunService({
    repo: testRepo,
    images: testImages,
    downloads: testDownloads,
    runner:
      options.tests?.runner ??
      new PlaywrightRunner({
        executablePath: () =>
          reportSettingsSchema.parse(settings.get('reportSettings', {})).chromiumPath,
      }),
    display: testDisplay,
    clock,
    ids,
    isRecording: (id) => testRecording.isRecording(id),
    onError: (err) => app.log.warn({ err }, 'test run failed'),
  });
  const testEvidences = new EvidenceService({
    repo: testRepo,
    images: testImages,
    clock,
    ids,
  });
  const testSessions = new TestSessionService({
    repo: testRepo,
    images: testImages,
    display: testDisplay,
    clock,
    ids,
    live: {
      state: (id) => (testRuns.isRunning(id) ? 'running' : testRecording.state(id)),
      warning: (id) => testRecording.warning(id),
      mode: (id) => testRecording.mode(id),
    },
    onError: (err) => app.log.warn({ err }, 'test session failed'),
  });
  registerStorageRoutes(app, {
    store: objectStore,
    monitor: storageMonitor,
    guard,
    bucket:
      config.storage.driver === 's3' && objectStore.driver === 's3' ? config.storage.bucket : null,
    prefix: config.storage.prefix,
    pending: () => reportRepo.countStoragePending(),
    lastError: () => reportSync.lastError(),
    flush: () => reportSync.flushAll(),
  });
  registerUsageRoutes(app, { service: usage, guard });
  registerLibraryRoutes(app, { service: library, guard, settings: librarySettings });
  registerNotebookLmRoutes(app, { service: notebookLmSettings, guard });
  registerTemplateRoutes(app, { service: templates, assistant: templateAssistant, guard });
  registerDiagramRoutes(app, { service: diagrams, guard });
  registerReportRoutes(app, { service: reportService, guard });
  registerTestRoutes(app, {
    sessions: testSessions,
    recording: testRecording,
    evidences: testEvidences,
    runs: testRuns,
    documents: new DocumentService({ repo: testRepo, images: testImages, clock }),
    downloads: testDownloads,
    images: testImages,
    guard,
  });
  // PNG of a prototype (shared Chromium) and its delivery to the CT document of a session
  const prototypeRenderer =
    options.prototypes?.renderer ?? new ChromiumPrototypeRenderer(chromiumBrowser);
  const prototypeRender = new PrototypeRenderService({
    prototypes,
    repo: prototypeRepo,
    files: prototypeFiles,
    renderer: prototypeRenderer,
    documents: new PrototypeDocumentSink({
      repo: testRepo,
      images: testImages,
      clock,
      ids,
      assertIdle: (id) => testSessions.assertIdle(id),
    }),
    clock,
  });
  prototypeHooks.thumbnails = new PrototypeThumbnails({
    prototypes,
    render: prototypeRender,
    ...(options.prototypes?.thumbnailDebounceMs !== undefined
      ? { debounceMs: options.prototypes.thumbnailDebounceMs }
      : {}),
    onError: (err) => app.log.warn({ err }, 'prototype thumbnail failed'),
  });
  registerPrototypeRoutes(app, {
    service: prototypes,
    render: prototypeRender,
    scene: new PrototypeSceneService({
      prototypes,
      files: prototypeFiles,
      renderer: prototypeRenderer,
    }),
    guard,
  });
  // "Caso de Teste CT" of a session: fields, preview, .docx / PDF / clipboard, upload to OneDrive
  const ctUsers = new SqliteUserRepository(db);
  const ctRenderers = createCtRenderers(pdfRenderer);
  const ctModels = new CtModelService({
    repo: new SqliteCtModelRepository(db),
    ids,
    clock,
    previewSample: (layout) => ctRenderers.previewHtml(CT_SAMPLE_DOCUMENT, () => '', layout),
  });
  registerCtRoutes(app, {
    service: new CtDocumentService({
      repo: testRepo,
      images: testImages,
      clock,
      renderers: ctRenderers,
      models: ctModels,
      publisher: {
        suggestFileName: (vars) => onedrive.suggestFileName(vars),
        upload: (input) => onedrive.uploadNewDocument(input),
      },
      defaultAuthor: async () => (await ctUsers.get())?.name ?? '',
      assertIdle: (id) => testSessions.assertIdle(id),
    }),
    guard,
  });
  // "Assistente de IA" of the CT document: router (+ privacy firewall), library and MCP tools
  registerCtAssistantRoutes(app, {
    assistant: new CtAssistant({
      router,
      ids,
      assertSession: async (id) => void (await testSessions.require(id)),
      tools: new CtAssistantToolsAdapter({ library, mcp }),
      forgetPrivacyScope: (scope) => privacyVaults.deleteScope(scope),
    }),
    guard,
  });
  // Models (looks) of the CT document, with "Criar modelo com IA" (router + privacy firewall)
  registerCtModelRoutes(app, {
    models: ctModels,
    assistant: new CtLayoutAssistant({
      router,
      ids,
      forgetPrivacyScope: (scope) => privacyVaults.deleteScope(scope),
    }),
    guard,
  });
  // "Assistente de IA" of the prototype editor: same router (+ privacy firewall) and sources
  registerPrototypeAssistantRoutes(app, {
    assistant: new PrototypeAssistant({
      router,
      ids,
      assertPrototype: async (id) => void (await prototypes.require(id)),
      tools: new CtAssistantToolsAdapter({ library, mcp }),
      forgetPrivacyScope: (scope) => privacyVaults.deleteScope(scope),
    }),
    guard,
  });
  registerV1Routes(app, { gateway, auth });

  await registerWebUi(app, config.webDir);

  app.addHook('onClose', async () => {
    prototypeHooks.thumbnails?.stop();
    await testRecording.stopAll();
    testRuns.stop();
    ingestion.stop();
    reportRunner.stop();
    await Promise.all([reportSync.stop(), reportJanitor.stop()]);
    await chromiumBrowser.close();
    notebookLmSettings.cancelLogin();
    await localOcr.terminate();
    await mcpGateway.closeAll();
    await pgGateway.closeAll();
    if (ownsObjectStore) await objectStore.close?.();
  });
  const migrateLibraryUploads = async (): Promise<void> => {
    if (!(await storageMonitor.status()).available) return; // next boot tries again
    const result = await migrateLegacyLibraryFiles(legacyLibraryDir, libraryObjects, {
      onError: (err, key) => app.log.warn({ err, key }, 'library upload migration failed'),
    });
    if (result.migrated || result.failed) {
      app.log.info(result, 'library uploads moved to the object store');
    }
  };
  // Never blocks the boot: with the storage down the server starts degraded (status says so).
  void prepareObjectStore(objectStore, config.storage, app.log)
    .then(() => storageMonitor.refresh())
    .catch((err: unknown) => app.log.warn({ err }, 'storage check failed'))
    .then(() => {
      void migrateLibraryUploads();
      if (options.reports?.autoStart === false) return;
      // uploads what is still in the staging column (and moves legacy PDFs), then keeps sweeping
      void reportSync
        .resumePending()
        .catch((err: unknown) => app.log.warn({ err }, 'report storage backfill failed'));
      reportJanitor.start();
    });
  void testRuns
    .recoverInterrupted()
    .catch((err: unknown) => app.log.warn({ err }, 'test runs recovery failed'));
  void ingestion
    .resumePending()
    .catch((err: unknown) => app.log.error({ err }, 'library resume failed'));
  if (options.reports?.autoStart !== false) {
    void reportRunner
      .resumePending()
      .catch((err: unknown) => app.log.error({ err }, 'reports resume failed'));
  }

  return {
    app,
    container: {
      auth,
      connections,
      router,
      mcp,
      chat,
      databases,
      onedrive,
      gateway,
      settings,
      mcpGateway,
      storage: {
        store: objectStore,
        monitor: storageMonitor,
        sync: {
          whenIdle: () => reportSync.whenIdle(),
          flushAll: () => reportSync.flushAll(),
          backfill: () => reportSync.backfill(),
        },
        janitor: { runOnce: () => reportJanitor.runOnce() },
      },
      library: {
        service: library,
        whenIdle: () => ingestion.whenIdle(),
        migrateLegacyFiles: () => migrateLegacyLibraryFiles(legacyLibraryDir, libraryObjects),
      },
      notebookLm: { settings: notebookLmSettings, gateway: nlmGateway, config: nlmConfig },
      tests: {
        sessions: testSessions,
        recording: testRecording,
        evidences: testEvidences,
        runs: testRuns,
        repo: testRepo,
      },
      prototypes,
      reports: {
        templates,
        service: reportService,
        runner: { whenIdle: () => reportRunner.whenIdle() },
      },
    },
  };
}

/** Serves the built dashboard (SPA) when available. */
async function registerWebUi(app: FastifyInstance, configured: string | undefined): Promise<void> {
  const candidates = [
    configured,
    path.resolve(process.cwd(), '../web/dist'),
    path.resolve(process.cwd(), 'public'),
  ].filter((p): p is string => !!p);
  const root = candidates.find((p) => fs.existsSync(path.join(p, 'index.html')));

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api/') || request.url.startsWith('/v1/');
    if (!root || isApi || request.method !== 'GET') {
      return reply.status(404).send({
        error: {
          code: 'not_found',
          message: `Rota não encontrada: ${request.method} ${request.url}`,
        },
      });
    }
    return reply.sendFile('index.html');
  });

  if (root) await app.register(fastifyStatic, { root, wildcard: false, index: ['index.html'] });
}
