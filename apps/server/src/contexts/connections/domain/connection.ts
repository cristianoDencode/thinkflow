import type { ConnectionStatus } from '@thinkflow/shared';

export interface ConnectionProps {
  id: string;
  providerId: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  priority: number;
  enabled: boolean;
  defaultModel: string;
  cooldownUntil: number | null;
  backoffLevel: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastUsedAt: number | null;
  successCount: number;
  failureCount: number;
  createdAt: number;
}

/**
 * Aggregate: one credential for one provider. Holds its own health state
 * (cooldown/backoff), which the routing context updates after each attempt.
 */
export class Connection {
  private constructor(private props: ConnectionProps) {}

  static create(
    input: Pick<
      ConnectionProps,
      'id' | 'providerId' | 'name' | 'apiKey' | 'baseUrl' | 'priority' | 'enabled' | 'defaultModel'
    >,
    now: number,
  ): Connection {
    return new Connection({
      ...input,
      cooldownUntil: null,
      backoffLevel: 0,
      lastError: null,
      lastErrorAt: null,
      lastUsedAt: null,
      successCount: 0,
      failureCount: 0,
      createdAt: now,
    });
  }

  static restore(props: ConnectionProps): Connection {
    return new Connection({ ...props });
  }

  get id() {
    return this.props.id;
  }
  get providerId() {
    return this.props.providerId;
  }
  get name() {
    return this.props.name;
  }
  get apiKey() {
    return this.props.apiKey;
  }
  get baseUrl() {
    return this.props.baseUrl;
  }
  get priority() {
    return this.props.priority;
  }
  get enabled() {
    return this.props.enabled;
  }
  get defaultModel() {
    return this.props.defaultModel;
  }
  get cooldownUntil() {
    return this.props.cooldownUntil;
  }
  get backoffLevel() {
    return this.props.backoffLevel;
  }
  get lastError() {
    return this.props.lastError;
  }
  get lastUsedAt() {
    return this.props.lastUsedAt;
  }

  toSnapshot(): ConnectionProps {
    return { ...this.props };
  }

  isInCooldown(now: number): boolean {
    return this.props.cooldownUntil !== null && this.props.cooldownUntil > now;
  }

  isAvailable(now: number): boolean {
    return this.props.enabled && !this.isInCooldown(now);
  }

  status(now: number): ConnectionStatus {
    if (!this.props.enabled) return 'disabled';
    if (this.isInCooldown(now)) return 'cooldown';
    if (this.props.successCount === 0 && this.props.failureCount === 0) return 'untested';
    const lastFailed =
      this.props.lastErrorAt !== null &&
      (this.props.lastUsedAt === null || this.props.lastErrorAt >= this.props.lastUsedAt);
    return lastFailed ? 'error' : 'ok';
  }

  update(
    changes: Partial<
      Pick<ConnectionProps, 'name' | 'apiKey' | 'baseUrl' | 'priority' | 'enabled' | 'defaultModel'>
    >,
  ): void {
    this.props = { ...this.props, ...stripUndefined(changes) };
  }

  registerSuccess(now: number): void {
    this.props.lastUsedAt = now;
    this.props.successCount += 1;
    this.props.cooldownUntil = null;
    this.props.backoffLevel = 0;
  }

  /**
   * A test call succeeded: the credential works right now, so the stale error and any cooldown
   * go away. Not a routed request, so the success counter and lastUsedAt stay untouched.
   */
  registerProbeSuccess(): void {
    this.props.lastError = null;
    this.props.lastErrorAt = null;
    this.props.cooldownUntil = null;
    this.props.backoffLevel = 0;
  }

  registerFailure(
    params: { message: string; cooldownUntil: number | null; backoffLevel: number },
    now: number,
  ): void {
    this.props.failureCount += 1;
    this.props.lastError = params.message.slice(0, 500);
    this.props.lastErrorAt = now;
    this.props.cooldownUntil = params.cooldownUntil;
    this.props.backoffLevel = params.backoffLevel;
  }

  resetCooldown(): void {
    this.props.cooldownUntil = null;
    this.props.backoffLevel = 0;
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
