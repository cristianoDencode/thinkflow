import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import {
  historySettingsSchema,
  modelAliasesSchema,
  settingsUpdateSchema,
  type SettingsDto,
} from '@thinkflow/shared';
import type { SettingsStore } from '../../infrastructure/settings-store';

export interface PresidioHealthDto {
  configured: boolean;
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: {
    settings: SettingsStore;
    guard: preHandlerHookHandler;
    publicBaseUrl: string;
    defaultAgentCwd: () => string;
    /** Health probe of the optional Presidio sidecar (never throws). */
    probePresidio: () => Promise<PresidioHealthDto>;
  },
): void {
  const read = async (): Promise<SettingsDto> => ({
    aliases: await deps.settings.getAliases(),
    agentDefaultCwd: deps.defaultAgentCwd(),
    baseUrl: deps.publicBaseUrl,
    history: historySettingsSchema.parse(deps.settings.get('chatHistory', {})),
    privacy: deps.settings.privacy(),
  });

  app.get('/api/settings', { preHandler: deps.guard }, read);

  app.get('/api/settings/privacy/presidio', { preHandler: deps.guard }, () => deps.probePresidio());

  app.put('/api/settings', { preHandler: deps.guard }, async (request) => {
    const data = settingsUpdateSchema.parse(request.body);
    if (data.aliases) deps.settings.set('aliases', modelAliasesSchema.parse(data.aliases));
    if (data.agentDefaultCwd !== undefined)
      deps.settings.set('agentDefaultCwd', data.agentDefaultCwd);
    if (data.history) {
      const current = historySettingsSchema.parse(deps.settings.get('chatHistory', {}));
      deps.settings.set(
        'chatHistory',
        historySettingsSchema.parse({ ...current, ...data.history }),
      );
    }
    if (data.privacy) deps.settings.setPrivacy(data.privacy);
    return read();
  });
}
