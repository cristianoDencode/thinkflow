import {
  NOTEBOOKLM_PLANS,
  notebookLmPlanForTier,
  notebookLmSettingsUpdateSchema,
  type NotebookLmLoginStatusDto,
  type NotebookLmSettingsDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { ConflictError, DomainError } from '../../../shared/kernel/errors';
import {
  DETECTION_MAX_AGE_MS,
  STORAGE_STATE_HELP,
  dayKey,
  effectiveNotebookLmLimits,
  normalizeStorageState,
} from '../domain/notebooklm';
import {
  NotebookLmError,
  type NotebookLmConfigStore,
  type NotebookLmAccountProbe,
  type NotebookLmGateway,
  type NotebookLmLocalProfile,
  type NotebookLmLoginHandle,
  type NotebookLmLoginOutcome,
  type NotebookLmLoginRunner,
} from '../domain/ports';

export interface NotebookLmSettingsServiceDeps {
  config: NotebookLmConfigStore;
  gateway: NotebookLmGateway;
  login: NotebookLmLoginRunner;
  localProfile: NotebookLmLocalProfile;
  /** Reads the account limits; without it detection is reported as unavailable. */
  probe?: NotebookLmAccountProbe;
  clock: Clock;
  /** How long the Google login window may stay open. Default 300 s. */
  loginTimeoutSec?: number;
  onError?: (err: unknown) => void;
}

/** Maps a gateway failure to a pt-BR API error (never 401: that would log the user out of Thinkflow). */
export function toDomainError(err: unknown): unknown {
  if (!(err instanceof NotebookLmError)) return err;
  return new DomainError(
    err.message,
    `notebooklm_${err.kind}`,
    err.kind === 'not_configured' ? 400 : 502,
  );
}

/**
 * Settings of the experimental NotebookLM integration: the Google session (never returned to the
 * client), the in-app login job, import of the CLI's existing login, manual renewal and a health check.
 */
export class NotebookLmSettingsService {
  private job: {
    id: number;
    handle: NotebookLmLoginHandle | null;
    status: NotebookLmLoginStatusDto;
  } | null = null;
  private jobSeq = 0;
  private detecting: Promise<void> | null = null;

  constructor(private readonly deps: NotebookLmSettingsServiceDeps) {}

  get(): NotebookLmSettingsDto {
    const { config, clock } = this.deps;
    const c = config.get();
    const limits = effectiveNotebookLmLimits(c);
    const detectedPlan = notebookLmPlanForTier(c.detected?.tier);
    return {
      enabled: c.enabled,
      hasCredentials: c.authJson !== null,
      credentialsUpdatedAt: c.credentialsUpdatedAt,
      cliCommand: c.cliCommand,
      plan: c.plan,
      detection: {
        at: c.detected?.at ?? null,
        sourceLimit: c.detected?.sourceLimit ?? null,
        notebookLimit: c.detected?.notebookLimit ?? null,
        tier: c.detected?.tier ?? null,
        planLabel: detectedPlan ? NOTEBOOKLM_PLANS[detectedPlan].label : null,
        unavailableReason: c.detectionError,
      },
      sourceLimit: limits.sourceLimit,
      notebookLimit: limits.notebookLimit,
      dailyQueryLimit: limits.chatsPerDay,
      dailyQueryLimitCustom: c.dailyQueryLimit !== null,
      queriesToday: config.queriesOn(dayKey(clock.now())),
      timeoutSec: c.timeoutSec,
      fallbackToLocal: c.fallbackToLocal,
      lastCheck: c.lastCheck,
      loginSupported: this.deps.login.support().supported,
      localProfileAvailable: this.deps.localProfile.exists(),
    };
  }

  async update(body: unknown): Promise<NotebookLmSettingsDto> {
    const { config, clock } = this.deps;
    const input = notebookLmSettingsUpdateSchema.parse(body);
    const { authJson, ...rest } = input;

    let credentials: string | null = null;
    if (authJson !== undefined && authJson.trim() !== '') {
      credentials = normalizeStorageState(authJson);
      if (!credentials)
        throw new DomainError(STORAGE_STATE_HELP, 'notebooklm_bad_credentials', 400);
    }
    if (rest.enabled === true && !credentials && config.get().authJson === null) {
      throw new DomainError(
        'Entre com o Google (ou importe o login) antes de ativar o NotebookLM',
        'notebooklm_not_configured',
        400,
      );
    }

    config.set({
      ...rest,
      ...(credentials ? { authJson: credentials, credentialsUpdatedAt: clock.now() } : {}),
    });
    if (credentials) {
      const check = await this.runCheck(rest.enabled === undefined);
      if (check.ok) await this.detectLimits(true);
    } else if (rest.cliCommand !== undefined) {
      this.deps.config.set({ detectionAttemptedAt: null }); // another CLI: look again soon
    }
    return this.get();
  }

  /** Verifies the session against NotebookLM and records the outcome as `lastCheck`. */
  async test(): Promise<{ ok: boolean; message: string }> {
    const result = await this.runCheck();
    if (result.ok) await this.detectLimits(true);
    return { ok: result.ok, message: result.message };
  }

  async removeCredentials(): Promise<NotebookLmSettingsDto> {
    this.cancelLogin();
    this.deps.config.set({
      authJson: null,
      credentialsUpdatedAt: null,
      lastCheck: null,
      enabled: false,
      detected: null,
      detectionAttemptedAt: null,
      detectionError: null,
    });
    return this.get();
  }

  /**
   * Reads the account limits (source/notebook limit, tier) with the CLI's Python. Never throws.
   * Without `force` it runs at most once every 12 h; a failure keeps the previously detected values.
   */
  detectLimits(force = false): Promise<void> {
    const { config, probe, clock } = this.deps;
    if (this.detecting) return this.detecting;
    const current = config.get();
    if (current.authJson === null) return Promise.resolve();
    const now = clock.now();
    if (
      !force &&
      current.detectionAttemptedAt !== null &&
      now - current.detectionAttemptedAt < DETECTION_MAX_AGE_MS
    )
      return Promise.resolve();
    config.set({ detectionAttemptedAt: now });
    const run = async (): Promise<void> => {
      try {
        const result = probe
          ? await probe.detect()
          : { ok: false as const, reason: 'Detecção automática indisponível neste servidor.' };
        if (result.ok) {
          config.set({
            detected: { at: clock.now(), ...result.limits },
            detectionError: null,
          });
        } else {
          config.set({ detectionError: result.reason });
        }
      } catch (err) {
        this.deps.onError?.(err);
        config.set({ detectionError: 'Falha ao detectar os limites da conta.' });
      }
    };
    this.detecting = run().finally(() => {
      this.detecting = null;
    });
    return this.detecting;
  }

  /** Adopts the login the user already did with the CLI on this machine. */
  async importLocal(): Promise<NotebookLmSettingsDto> {
    const raw = await this.deps.localProfile.read();
    if (raw === null) {
      throw new DomainError(
        'Nenhum login do NotebookLM encontrado neste computador. Use "Entrar com Google".',
        'notebooklm_no_local_profile',
        404,
      );
    }
    const credentials = normalizeStorageState(raw);
    if (!credentials) {
      throw new DomainError(
        'O login existente do NotebookLM está inválido. Use "Entrar com Google".',
        'notebooklm_bad_credentials',
        400,
      );
    }
    this.deps.config.set({ authJson: credentials, credentialsUpdatedAt: this.deps.clock.now() });
    const check = await this.runCheck(true);
    if (check.ok) await this.detectLimits(true);
    return this.get();
  }

  /** "Renovar agora": rotates the Google cookies right away. */
  async refresh(): Promise<NotebookLmSettingsDto> {
    if (this.deps.config.get().authJson === null) {
      throw new DomainError('NotebookLM não configurado', 'notebooklm_not_configured', 400);
    }
    try {
      await this.deps.gateway.refreshCredentials();
    } catch (err) {
      throw toDomainError(err);
    }
    await this.runCheck();
    return this.get();
  }

  /* ---- in-app Google login ---- */

  loginStatus(): NotebookLmLoginStatusDto {
    const support = this.deps.login.support();
    if (!support.supported) return { state: 'unsupported', message: support.message };
    return this.job?.status ?? { state: 'idle', message: '' };
  }

  startLogin(): NotebookLmLoginStatusDto {
    const support = this.deps.login.support();
    if (!support.supported) {
      throw new DomainError(support.message, 'notebooklm_login_unsupported', 400);
    }
    if (this.job?.status.state === 'waiting') {
      throw new ConflictError('Já existe um login do Google em andamento');
    }
    const id = ++this.jobSeq;
    const handle = this.deps.login.start({
      cliCommand: this.deps.config.get().cliCommand,
      timeoutSec: this.deps.loginTimeoutSec ?? 300,
    });
    this.job = {
      id,
      handle,
      status: {
        state: 'waiting',
        message: 'Uma janela de login do Google foi aberta. Conclua o login nela.',
      },
    };
    void handle.result
      .then((outcome) => this.finishLogin(id, outcome))
      .catch((err: unknown) => {
        this.deps.onError?.(err);
        this.setJob(id, { state: 'error', message: 'O login falhou. Tente novamente.' });
      });
    return this.job.status;
  }

  cancelLogin(): NotebookLmLoginStatusDto {
    const job = this.job;
    if (job?.status.state === 'waiting') {
      job.handle?.cancel();
      // `finishLogin` settles the state; report idle right away so the UI does not wait
      this.setJob(job.id, { state: 'idle', message: 'Login cancelado.' });
    } else if (job) {
      this.job = null;
    }
    return this.loginStatus();
  }

  private setJob(id: number, status: NotebookLmLoginStatusDto): void {
    if (this.job?.id === id) this.job.status = status;
  }

  private async finishLogin(id: number, outcome: NotebookLmLoginOutcome): Promise<void> {
    if (this.job?.id !== id || this.job.status.state !== 'waiting') return; // cancelled or replaced
    if (!outcome.ok) {
      return this.setJob(id, { state: 'error', message: outcome.message });
    }
    const credentials = normalizeStorageState(outcome.storageState);
    if (!credentials) {
      return this.setJob(id, {
        state: 'error',
        message: 'O login não gerou credenciais válidas. Tente novamente.',
      });
    }
    this.deps.config.set({ authJson: credentials, credentialsUpdatedAt: this.deps.clock.now() });
    this.setJob(id, { state: 'waiting', message: 'Login concluído. Verificando a conexão…' });
    const check = await this.runCheck(true);
    if (check.ok) await this.detectLimits(true);
    if (this.job?.id !== id || this.job.status.state !== 'waiting') return; // cancelled meanwhile
    this.setJob(id, {
      state: 'done',
      message: check.ok
        ? `Login concluído. ${check.message}`
        : `Login salvo, mas a verificação falhou: ${check.message}`,
    });
  }

  /** `adopt`: new credentials were just stored — turn the integration on if they work. */
  private async runCheck(
    adopt = false,
  ): Promise<{ ok: boolean; message: string; account?: string }> {
    const { config, gateway, clock } = this.deps;
    let result: { ok: boolean; message: string; account?: string };
    try {
      result = await gateway.check();
    } catch (err) {
      result = {
        ok: false,
        message: err instanceof NotebookLmError ? err.message : 'Falha ao verificar o NotebookLM',
      };
    }
    config.set({
      lastCheck: {
        at: clock.now(),
        ok: result.ok,
        message: result.message,
        account: result.account ?? null,
      },
      ...(adopt && result.ok ? { enabled: true } : {}),
    });
    return result;
  }
}
