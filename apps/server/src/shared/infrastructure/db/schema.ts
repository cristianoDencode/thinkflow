import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  title: text('title').notNull().default(''),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const connections = sqliteTable(
  'connections',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    name: text('name').notNull(),
    apiKeyEnc: text('api_key_enc').notNull().default(''),
    baseUrl: text('base_url').notNull().default(''),
    priority: integer('priority').notNull().default(10),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    defaultModel: text('default_model').notNull().default(''),
    cooldownUntil: integer('cooldown_until'),
    backoffLevel: integer('backoff_level').notNull().default(0),
    lastError: text('last_error'),
    lastErrorAt: integer('last_error_at'),
    lastUsedAt: integer('last_used_at'),
    successCount: integer('success_count').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('connections_provider_idx').on(t.providerId)],
);

/**
 * What a provider told us about a connection's quota (rate-limit headers or a 429 message),
 * one row per metric/window. Rows live and die with their connection.
 */
export const connectionQuota = sqliteTable(
  'connection_quota',
  {
    connectionId: text('connection_id').notNull(),
    /** 'requests' | 'tokens' */
    metric: text('metric').notNull(),
    /** 'day' | 'minute' | 'unknown' */
    window: text('quota_window').notNull(),
    limit: integer('quota_limit').notNull(),
    remaining: integer('remaining'),
    used: integer('used'),
    resetAt: integer('reset_at'),
    model: text('model'),
    /** 'headers' | 'error' */
    source: text('source').notNull(),
    observedAt: integer('observed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.metric, t.window] })],
);

export const combos = sqliteTable('combos', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  strategy: text('strategy').notNull().default('priority'),
  targets: text('targets').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const requestLogs = sqliteTable(
  'request_logs',
  {
    id: text('id').primaryKey(),
    createdAt: integer('created_at').notNull(),
    source: text('source').notNull(),
    requestedModel: text('requested_model').notNull(),
    providerId: text('provider_id'),
    model: text('model'),
    connectionId: text('connection_id'),
    success: integer('success', { mode: 'boolean' }).notNull(),
    httpStatus: integer('http_status'),
    reason: text('reason'),
    latencyMs: integer('latency_ms').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    attempts: text('attempts').notNull().default('[]'),
    /** Privacy firewall counters (never values): spans tokenized / images sent unfiltered. */
    privacyTokenized: integer('privacy_tokenized'),
    imagesUnfiltered: integer('images_unfiltered'),
  },
  (t) => [index('request_logs_created_idx').on(t.createdAt)],
);

export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  transport: text('transport').notNull(),
  configEnc: text('config_enc').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});

/** Postgres connections of "Dados com IA" (the password is AES-256-GCM via SecretBox). */
export const databaseConnections = sqliteTable('database_connections', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  database: text('database').notNull(),
  user: text('user').notNull(),
  passwordEnc: text('password_enc').notNull().default(''),
  sslMode: text('ssl_mode').notNull().default('disable'),
  /** JSON string[] */
  schemas: text('schemas').notNull().default('[]'),
  aiAccess: text('ai_access').notNull().default('schema'),
  sampleRows: integer('sample_rows').notNull().default(20),
  /** JSON string[] */
  sensitiveColumns: text('sensitive_columns').notNull().default('[]'),
  /** JSON string[] */
  revealColumns: text('reveal_columns').notNull().default('[]'),
  statementTimeoutSec: integer('statement_timeout_sec').notNull().default(30),
  maxRows: integer('max_rows').notNull().default(1000),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  /** MCP server with the data dictionary used to suggest names (see `MetadataLookup`). */
  metadataMcpServerId: text('metadata_mcp_server_id'),
  metadataMcpProject: text('metadata_mcp_project'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * What the AI may see of a column of a database connection (see the `privacy` context).
 * `schema_name`/`table_name` = '*' → the rule covers that column name anywhere (legacy lists).
 * Identifiers are stored lowercase.
 */
export const aiColumnRules = sqliteTable(
  'ai_column_rules',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => databaseConnections.id, { onDelete: 'cascade' }),
    schemaName: text('schema_name').notNull(),
    tableName: text('table_name').notNull(),
    columnName: text('column_name').notNull(),
    /** 'reveal' | 'tokenize' | 'omit' */
    action: text('action').notNull(),
    /** PiiKind, or null = generic token */
    kind: text('kind'),
    /** 'auto' | 'analyst' */
    origin: text('origin').notNull().default('analyst'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('ai_column_rules_uq').on(t.connectionId, t.schemaName, t.tableName, t.columnName),
    index('ai_column_rules_column_idx').on(t.connectionId, t.columnName),
  ],
);

/**
 * Reversible tokens of the privacy firewall. `scope_id` is the owner (conversation, report...)
 * and has no FK on purpose: it is deleted explicitly with its owner. The value is AES-256-GCM
 * ciphertext; `value_hash` is a keyed HMAC of the normalized value (deduplication without
 * storing it in clear).
 */
export const piiVault = sqliteTable(
  'pii_vault',
  {
    scopeId: text('scope_id').notNull(),
    token: text('token').notNull(),
    kind: text('kind').notNull(),
    valueCipher: text('value_cipher').notNull(),
    valueHash: text('value_hash').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.token] }),
    uniqueIndex('pii_vault_hash_uq').on(t.scopeId, t.valueHash),
  ],
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    mode: text('mode').notNull().default('chat'),
    model: text('model').notNull(),
    agentSessionId: text('agent_session_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** Fork origin (no FK on purpose: may dangle after the parent is deleted). */
    parentConversationId: text('parent_conversation_id'),
    forkedFromMessageId: text('forked_from_message_id'),
    summary: text('summary'),
    summaryThroughMessageId: text('summary_through_message_id'),
    /** 'llm' | 'extractive' */
    summaryKind: text('summary_kind'),
    summaryUpdatedAt: integer('summary_updated_at'),
    agentCwd: text('agent_cwd'),
    agentPermissionMode: text('agent_permission_mode'),
    /** Connected library (no FK on purpose: may dangle after the library is deleted). */
    libraryId: text('library_id'),
    /** Document-template preset (`report` | `summary` | `prd` | `prototype`); both columns are set or both null. */
    presetKind: text('preset_kind'),
    /** No FK on purpose: may dangle after the template is deleted. */
    presetTemplateId: text('preset_template_id'),
    /** Mode `data`: Postgres connection queried (no FK: may dangle after it is deleted). */
    databaseId: text('database_id'),
  },
  (t) => [index('conversations_updated_idx').on(t.updatedAt)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    meta: text('meta').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

/** Per-day token usage aggregates (request_logs is pruned, this is not). */
export const usageDaily = sqliteTable(
  'usage_daily',
  {
    /** 'YYYY-MM-DD' in the server's local time zone. */
    day: text('day').notNull(),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    source: text('source').notNull(),
    requests: integer('requests').notNull().default(0),
    failures: integer('failures').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    estimatedRequests: integer('estimated_requests').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.providerId, t.model, t.source] })],
);

/** Document libraries the chat can consult (see contexts/library). */
export const libraries = sqliteTable('libraries', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  /** 'local' | 'notebooklm' */
  engine: text('engine').notNull().default('local'),
  remoteNotebookId: text('remote_notebook_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const libraryDocuments = sqliteTable(
  'library_documents',
  {
    id: text('id').primaryKey(),
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mimeType: text('mime_type').notNull(),
    kind: text('kind').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    /** 'processing' | 'ready' | 'error' */
    status: text('status').notNull().default('processing'),
    error: text('error'),
    /** 'text' | 'ocr-local' | 'ocr-vision' */
    extraction: text('extraction'),
    pageCount: integer('page_count'),
    charCount: integer('char_count').notNull().default(0),
    chunkCount: integer('chunk_count').notNull().default(0),
    storageKey: text('storage_key').notNull(),
    remoteSourceId: text('remote_source_id'),
    /** 'pending' | 'syncing' | 'synced' | 'error' */
    remoteStatus: text('remote_status'),
    remoteError: text('remote_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('library_documents_hash_uq').on(t.libraryId, t.sha256),
    index('library_documents_library_idx').on(t.libraryId, t.createdAt),
    index('library_documents_status_idx').on(t.status),
  ],
);

/** Indexed by the FTS5 table `library_chunks_fts` (migration 0004, kept in sync by triggers). */
export const libraryChunks = sqliteTable(
  'library_chunks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentId: text('document_id')
      .notNull()
      .references(() => libraryDocuments.id, { onDelete: 'cascade' }),
    libraryId: text('library_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    heading: text('heading'),
    pageFrom: integer('page_from'),
    pageTo: integer('page_to'),
    tokenEstimate: integer('token_estimate').notNull(),
  },
  (t) => [
    index('library_chunks_doc_idx').on(t.documentId, t.ordinal),
    index('library_chunks_lib_idx').on(t.libraryId),
  ],
);

/** Document templates ("Modelos"): built-in seeds (read-only) and user-made ones. */
export const reportTemplates = sqliteTable(
  'report_templates',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** 'report' | 'summary' | 'prd' | 'prototype' */
    kind: text('kind').notNull(),
    description: text('description').notNull().default(''),
    builtIn: integer('built_in', { mode: 'boolean' }).notNull().default(false),
    /** Seeds are upgraded at boot when the code's version is higher. */
    builtInVersion: integer('built_in_version'),
    /** JSON TemplateSpec (validated with zod on read). */
    spec: text('spec').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('report_templates_kind_name_uq').on(t.kind, t.name),
    index('report_templates_kind_idx').on(t.kind),
  ],
);

/** Generated documents ("Relatórios"): one background job each, resumable from the saved state. */
export const reports = sqliteTable(
  'reports',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    /** 'report' | 'summary' | 'prd' | 'prototype' */
    kind: text('kind').notNull(),
    /** No FK on purpose: deleting a template never touches its reports (they keep the snapshot). */
    templateId: text('template_id'),
    templateName: text('template_name').notNull(),
    /** JSON TemplateSpec as it was when the report was created. */
    templateSnapshot: text('template_snapshot').notNull(),
    status: text('status').notNull(),
    /** JSON { phase, current, total, label, job? } */
    progress: text('progress').notNull(),
    error: text('error'),
    failedPhase: text('failed_phase'),
    cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
    model: text('model').notNull(),
    variables: text('variables').notNull().default('{}'),
    brief: text('brief').notNull().default(''),
    libraryId: text('library_id'),
    useMcp: integer('use_mcp', { mode: 'boolean' }).notNull().default(false),
    conversationId: text('conversation_id'),
    /** JSON ResearchStep[] (null until the plan exists). */
    plan: text('plan'),
    researchDone: integer('research_done').notNull().default(0),
    /** JSON SectionOutline[] (null until the outline exists). */
    outline: text('outline'),
    /** Staging (outbox) for the document: filled by the assembly, emptied once the object store has it. */
    html: text('html'),
    markdown: text('markdown'),
    meta: text('meta').notNull().default('{}'),
    /** Cached PDF: the object key of the current version, or the legacy `<id>.pdf` file name. */
    pdfKey: text('pdf_key'),
    pdfAt: integer('pdf_at'),
    /** sha256(html)[:16]: the version segment of the object keys (`reports/<id>/<hash>/...`). */
    htmlHash: text('html_hash'),
    /** When the HTML (and Markdown copy) of `htmlHash` were confirmed in the object store. */
    artifactsStoredAt: integer('artifacts_stored_at'),
    storageAttempts: integer('storage_attempts').notNull().default(0),
    /** Earliest time of the next upload attempt (backoff). */
    storageNextAt: integer('storage_next_at'),
    storageError: text('storage_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    index('reports_status_idx').on(t.status),
    index('reports_created_idx').on(t.createdAt),
    index('reports_storage_idx').on(t.status, t.artifactsStoredAt),
  ],
);

export const reportSections = sqliteTable(
  'report_sections',
  {
    reportId: text('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    title: text('title').notNull(),
    requirements: text('requirements').notNull().default(''),
    /** 'section' | 'screen' */
    role: text('role').notNull().default('section'),
    /** 'pending' | 'writing' | 'done' | 'error' */
    status: text('status').notNull().default('pending'),
    markdown: text('markdown').notNull().default(''),
    html: text('html'),
    noteIds: text('note_ids').notNull().default('[]'),
    model: text('model'),
    providerId: text('provider_id'),
    warnings: text('warnings').notNull().default('[]'),
    error: text('error'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.ordinal] })],
);

/** Research results (tool outputs, attachments, the brief) that the sections are written from. */
export const reportNotes = sqliteTable(
  'report_notes',
  {
    id: text('id').primaryKey(),
    reportId: text('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    /** 0 = inputs (brief, attachments); 1.. = research steps. */
    step: integer('step').notNull(),
    ordinal: integer('ordinal').notNull(),
    /** 'mcp' | 'library' | 'attachment' | 'model' | 'brief' */
    source: text('source').notNull(),
    toolName: text('tool_name'),
    query: text('query'),
    content: text('content').notNull(),
    /** JSON number[]: sections (1-based) the research step was looking for. */
    sectionHints: text('section_hints').notNull().default('[]'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('report_notes_report_idx').on(t.reportId, t.step, t.ordinal)],
);

/** Test sessions ("Testes"): recorded steps, parameters and data sets live in `definition`. */
export const testSessions = sqliteTable(
  'test_sessions',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    startUrl: text('start_url').notNull(),
    /** JSON TestDefinition (validated with zod on read); secret values are only markers. */
    definition: text('definition').notNull(),
    /** SecretBox(JSON { [dataSetId]: { [parameterId]: value } }). */
    secretsEnc: text('secrets_enc').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('test_sessions_updated_idx').on(t.updatedAt)],
);

/**
 * The image of a step (automatic print of a recorded step or manual print of a `capture` step),
 * with the editable annotations and the comment. At most one per step.
 */
export const testEvidences = sqliteTable(
  'test_evidences',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => testSessions.id, { onDelete: 'cascade' }),
    stepId: text('step_id'),
    seq: integer('seq').notNull(),
    at: integer('at').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** Object keys in the `tests/` namespace. */
    originalKey: text('original_key').notNull(),
    annotatedKey: text('annotated_key'),
    /** JSON TestAnnotation[] */
    annotations: text('annotations').notNull().default('[]'),
    /** JSON TestCrop (selected area of the screenshot) or null for the whole image */
    crop: text('crop'),
    comment: text('comment').notNull().default(''),
    include: integer('include', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('test_evidences_session_idx').on(t.sessionId, t.seq),
    uniqueIndex('test_evidences_step_unique').on(t.stepId),
  ],
);

/** Replays of a session (one data set each). */
export const testRuns = sqliteTable(
  'test_runs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => testSessions.id, { onDelete: 'cascade' }),
    /** Order in the session (1 = first). */
    seq: integer('seq').notNull().default(0),
    /** The run this one reproduces. */
    rerunOf: text('rerun_of'),
    /** JSON {dataSetName, parameters, values}: the data the run used (secrets apart). Null = not kept. */
    dataSnapshot: text('data_snapshot'),
    /** Encrypted JSON of the snapshot's secret values (same cipher as the session secrets). */
    dataSecretsEnc: text('data_secrets_enc').notNull().default(''),
    dataSetId: text('data_set_id'),
    /** queued | running | passed | failed | error | canceled */
    status: text('status').notNull(),
    headed: integer('headed', { mode: 'boolean' }).notNull().default(false),
    /** JSON TestStepResult[] */
    results: text('results').notNull().default('[]'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    index('test_runs_session_idx').on(t.sessionId, t.createdAt),
    index('test_runs_status_idx').on(t.status),
  ],
);

/**
 * Files the browser downloaded while recording or replaying a session. The bytes live in the
 * object storage (`object_key`, `tests/` namespace); not part of the evidence document.
 */
export const testDownloads = sqliteTable(
  'test_downloads',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => testSessions.id, { onDelete: 'cascade' }),
    /** The step that triggered it (null = none close enough; may point to a removed step). */
    stepId: text('step_id'),
    runId: text('run_id'),
    /** recording | replay */
    source: text('source').notNull(),
    fileName: text('file_name').notNull(),
    size: integer('size').notNull().default(0),
    contentType: text('content_type').notNull().default('application/octet-stream'),
    /** Origin + path (no query string). */
    url: text('url').notNull().default(''),
    /** saved | failed | skipped */
    status: text('status').notNull(),
    reason: text('reason'),
    objectKey: text('object_key'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('test_downloads_session_idx').on(t.sessionId, t.createdAt),
    index('test_downloads_run_idx').on(t.runId),
  ],
);

/**
 * OneDrive (personal Microsoft account) integration: a single row (`id = 'default'`) with the app
 * registration, the connected account and the tokens. Secrets and tokens are AES-256-GCM via SecretBox.
 */
export const onedriveAccount = sqliteTable('onedrive_account', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().default(''),
  clientSecretEnc: text('client_secret_enc').notNull().default(''),
  /** Manual redirect URI (reverse proxy); empty = derived from the request address. */
  redirectUriOverride: text('redirect_uri_override').notNull().default(''),
  namingPattern: text('naming_pattern').notNull().default('CT {ticketId} - {title}.docx'),
  defaultFolderId: text('default_folder_id'),
  defaultFolderName: text('default_folder_name'),
  defaultFolderPath: text('default_folder_path'),
  /** 'disconnected' | 'connected' | 'reconnect_required' */
  state: text('state').notNull().default('disconnected'),
  accountId: text('account_id'),
  accountName: text('account_name'),
  accountEmail: text('account_email'),
  accessTokenEnc: text('access_token_enc').notNull().default(''),
  refreshTokenEnc: text('refresh_token_enc').notNull().default(''),
  accessTokenExpiresAt: integer('access_token_expires_at'),
  connectedAt: integer('connected_at'),
  updatedAt: integer('updated_at').notNull(),
});

/** Pending OAuth authorizations (CSRF `state` + PKCE verifier); single use, short lived. */
export const onedriveAuthRequests = sqliteTable('onedrive_auth_requests', {
  state: text('state').primaryKey(),
  codeVerifierEnc: text('code_verifier_enc').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * Screen prototypes ("Protótipos"). The HTML/CSS of every version lives in the object store
 * (`prototypes/<id>/<versionId>.json`); only metadata is kept here. Deleting a test session
 * unlinks its prototypes (it never deletes them).
 */
export const prototypes = sqliteTable(
  'prototypes',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    sessionId: text('session_id').references(() => testSessions.id, { onDelete: 'set null' }),
    /** Step of the session where the screen was captured (no foreign key: steps are JSON). */
    stepId: text('step_id'),
    /** JSON PrototypeSource. */
    source: text('source').notNull().default('{}'),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    scrubbed: integer('scrubbed', { mode: 'boolean' }).notNull().default(false),
    currentVersionId: text('current_version_id').notNull(),
    /** Object key of the last rendered PNG (phase P3); null until rendered. */
    thumbnailKey: text('thumbnail_key'),
    /** Version the PNG was rendered from, when it was, and at which device scale (1 or 2). */
    renderedVersionId: text('rendered_version_id'),
    renderedAt: integer('rendered_at'),
    renderedScale: integer('rendered_scale').notNull().default(1),
    /** JSON `PrototypeSentTo[]`: the steps of test sessions the PNG was sent to. */
    sentTo: text('sent_to').notNull().default('[]'),
    /** 'prototype' or 'template' ("modelo": a starting point for new prototypes). */
    kind: text('kind').notNull().default('prototype'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('prototypes_session_idx').on(t.sessionId),
    index('prototypes_updated_idx').on(t.updatedAt),
    index('prototypes_kind_idx').on(t.kind),
  ],
);

export const prototypeVersions = sqliteTable(
  'prototype_versions',
  {
    id: text('id').primaryKey(),
    prototypeId: text('prototype_id')
      .notNull()
      .references(() => prototypes.id, { onDelete: 'cascade' }),
    /** 1, 2, 3… per prototype (never reused, even after old versions are dropped). */
    seq: integer('seq').notNull(),
    note: text('note').notNull().default(''),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** Size of the stored HTML + CSS. */
    bytes: integer('bytes').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('prototype_versions_seq_idx').on(t.prototypeId, t.seq)],
);

/** Reusable components saved by the user for the editor palette. */
export const prototypeBlocks = sqliteTable('prototype_blocks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  html: text('html').notNull(),
  css: text('css').notNull().default(''),
  /** Where a favorite came from, e.g. "Favorito de Consulta Empenho"; null for other blocks. */
  source: text('source'),
  createdAt: integer('created_at').notNull(),
});

/** Named looks ("modelos") of the "Caso de Teste CT" document; `layout` is a JSON `CtLayout`. */
export const ctModels = sqliteTable('ct_models', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  layout: text('layout').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
