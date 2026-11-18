# 0003. Provider routing with fallback and cooldown

## Status

Accepted

## Context

Free tiers and cheap providers are the target users' main source of model access, and they are
unreliable in predictable ways: rate limits, daily quotas, overloaded models, expired keys and
models that are retired. A client that is bound to one provider stops whenever that provider
does. Clients such as Claude Code also expect one stable endpoint and model name.

## Decision

Every model call goes through one router (`contexts/routing`):

- A requested name is resolved to an **ordered list of targets**: a combo, `provider/model`,
  `auto`, a Claude-family alias or a real Claude name, or a default alias.
- Provider errors are **classified** (`rate_limited`, `quota_exhausted`, `capacity`, `server`,
  `network`, `auth`, `model_unavailable`, `context_length`, `bad_request`). Each class decides
  whether to try the next connection, skip to the next target, or stop.
- A failing connection gets a **cooldown**: `Retry-After` when the provider sends it, otherwise
  exponential backoff (1 s doubling up to 2 minutes), midnight UTC for daily quotas, fixed values
  for capacity and auth errors. Cooled-down connections are skipped and recover on their own.
- Connections of the same provider are ordered by priority, then round-robin by least recently
  used. In streaming, the switch is allowed only until the first event reaches the client.
- Anthropic and OpenAI wire formats are translated in `contexts/protocol`, so the same router
  serves the dashboard, the Agent SDK and both `/v1` endpoints.
- The privacy firewall runs inside the router, so no path to a provider bypasses it.

## Consequences

- Clients see one stable model name while the router absorbs failures.
- Behavior is deterministic and unit-testable (the routing domain has coverage thresholds in CI).
- State (cooldowns, learned context limits, quotas) is per installation and heuristic; a wrong
  classification can skip a healthy connection until its cooldown ends.
- After the first streamed event a failure cannot be retried transparently.
- Provider quirks must be added to the classifier as they are found.
