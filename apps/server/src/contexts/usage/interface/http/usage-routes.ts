import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { usageBudgetSchema } from '@thinkflow/shared';
import type { UsageService } from '../../application/usage-service';

export function registerUsageRoutes(
  app: FastifyInstance,
  deps: { service: UsageService; guard: preHandlerHookHandler },
): void {
  const { service } = deps;
  const opts = { preHandler: deps.guard };

  app.get<{ Querystring: { month?: string } }>('/api/usage', opts, async (request) =>
    service.report(request.query.month || undefined),
  );
  app.get('/api/usage/months', opts, async () => service.months());
  app.put('/api/usage/budget', opts, async (request) => {
    const { monthlyTokens } = usageBudgetSchema.parse(request.body);
    service.setBudget(monthlyTokens);
    return service.report();
  });
}
