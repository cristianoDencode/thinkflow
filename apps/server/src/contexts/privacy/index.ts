/**
 * Public surface of the privacy bounded context (personal-data firewall for the AI).
 * Other contexts import from here (domain only) or from `./infrastructure/*` in the composition root.
 */
export { PII_KINDS, TOKEN_RE, MAX_TOKEN_LENGTH, isToken } from './domain/pii';
export type { Detector, PiiKind, Span, SpanSource } from './domain/pii';
export { detectAll, resolveSpans, tokenRanges } from './domain/detect';
export type { DetectOptions } from './domain/detect';
export { NATIVE_DETECTORS } from './domain/detectors';
export { nameDetector, isFirstName } from './domain/names';
export { InMemoryVault, formatToken, normalizeForVault, parseToken } from './domain/vault';
export type { Vault, VaultEntry } from './domain/vault';
export { restore, tokenize, tokenizeValue } from './domain/tokenizer';
export { StreamRestorer } from './domain/stream-restorer';
export { columnRefKey, normalizeIdent, WILDCARD } from './domain/column-rule';
export type { ColumnRef, ColumnRule } from './domain/column-rule';
export type { ColumnRuleRepository, UpsertColumnRule, VaultStore } from './domain/ports';
export { columnTypeKind, canHoldDocumentNumber } from './domain/column-types';
export { piiKindOfMask, sensitiveKindByName } from './domain/column-names';
export { needsReview, settle } from './domain/classification';
export type {
  ClassificationOrigin,
  ColumnAction,
  ColumnClassification,
} from './domain/classification';
export { classifyColumns } from './application/classify-columns';
export { PrivacyFirewall } from './application/privacy-firewall';
export type {
  ExtraSpansProvider,
  PrivacyFirewallDeps,
  ProtectResult,
} from './application/privacy-firewall';
export { restoreStream } from './application/restore-stream';
export type { RestoreStreamOptions } from './application/restore-stream';
export { EphemeralVaultCache } from './application/ephemeral-vault-cache';
