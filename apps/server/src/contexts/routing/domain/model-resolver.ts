import type { ModelAliases } from '@thinkflow/shared';
import type { Combo, ComboTarget } from '../../connections/domain/combo';
import { DomainError } from '../../../shared/kernel/errors';

export interface ResolveContext {
  findCombo(name: string): Combo | undefined;
  hasProvider(providerId: string): boolean;
  hasConnectionsFor(providerId: string): boolean;
  /** Providers with at least one connection, in preference order (used by "auto"). */
  connectedProviders?(): string[];
  aliases: ModelAliases;
  /** Monotonic counter used by round-robin combos. */
  sequence: number;
}

export interface Resolution {
  kind: 'combo' | 'direct';
  label: string;
  targets: ComboTarget[];
}

export class UnknownModelError extends DomainError {
  constructor(model: string) {
    super(
      `Modelo desconhecido: "${model}". Use o nome de um combo ou "provider/modelo", ou configure um alias padrão.`,
      'model_not_found',
      404,
    );
  }
}

/**
 * Resolves a requested model name into an ordered list of targets:
 * 1. combo name  2. "provider/model"  3. Claude-family aliases (opus/sonnet/haiku)
 * 4. real Anthropic model when an Anthropic connection exists  5. default alias.
 */
export function resolveModel(model: string, ctx: ResolveContext, depth = 0): Resolution {
  if (depth > 4) throw new UnknownModelError(model);
  const name = model.trim();

  const combo = ctx.findCombo(name);
  if (!combo && name.toLowerCase() === 'auto') {
    const providers = ctx.connectedProviders?.() ?? [];
    if (providers.length === 0) throw new UnknownModelError(name);
    return {
      kind: 'combo',
      label: 'auto',
      targets: providers.map((providerId) => ({ providerId, model: 'auto' })),
    };
  }
  if (combo)
    return { kind: 'combo', label: combo.name, targets: combo.orderedTargets(ctx.sequence) };

  const slash = name.indexOf('/');
  if (slash > 0) {
    const providerId = name.slice(0, slash);
    const providerModel = name.slice(slash + 1);
    if (ctx.hasProvider(providerId) && providerModel) {
      return { kind: 'direct', label: name, targets: [{ providerId, model: providerModel }] };
    }
  }

  const lower = name.toLowerCase();
  for (const family of ['opus', 'sonnet', 'haiku'] as const) {
    const alias = ctx.aliases[family];
    if (lower.includes(family) && alias && alias !== name)
      return resolveModel(alias, ctx, depth + 1);
  }

  if (lower.startsWith('claude-') && ctx.hasConnectionsFor('anthropic')) {
    return {
      kind: 'direct',
      label: `anthropic/${name}`,
      targets: [{ providerId: 'anthropic', model: name }],
    };
  }

  const fallback = ctx.aliases.default;
  if (fallback && fallback !== name) return resolveModel(fallback, ctx, depth + 1);

  throw new UnknownModelError(name);
}
