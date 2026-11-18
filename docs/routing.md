# Routing

Thinkflow keeps a list of **connections** (a provider plus an API key) and routes every model call
across them, so a rate limit or an exhausted free tier on one provider does not stop your work.
All traffic goes through the same router: dashboard chat, Agent mode, reports, history summaries,
Data with AI and the `/v1` gateway ([claude-code.md](claude-code.md)).

## Connections and combos

- A **connection** is a provider (OpenRouter, Groq, Mistral, NVIDIA NIM, DeepSeek, Ollama,
  LM Studio, Anthropic, OpenAI, or a custom OpenAI- or Anthropic-compatible endpoint) with its
  API key, optional base URL and a **priority** (lower first). Keys are encrypted at rest.
- A **combo** is a "virtual model": an ordered list of `provider/model` targets, for example
  `thinkflow/default`. Drag targets in the dashboard (Connections, Combos) to set the order.

## How a model name is resolved

The requested model is resolved in this order:

1. the name of a **combo**;
2. `provider/model` (a single target);
3. `auto`: one target per connected provider, each picking a usable **text** chat model from the
   provider's live model list (speech, image, embedding and moderation models are skipped);
4. a Claude-family name (`opus`, `sonnet`, `haiku`) is mapped through the **model mapping** in
   Settings;
5. a real `claude-…` name goes straight to Anthropic if an Anthropic connection exists;
6. otherwise the configured **default alias**, or a `model_not_found` error.

## How errors are handled

| Provider error                       | Classification                         | What happens                                                                      |
| ------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------- |
| 429                                  | `rate_limited`                         | next connection; cooldown = `Retry-After`, or backoff (1s, 2s, 4s... up to 2 min) |
| 402 or "quota", "credits", "billing" | `quota_exhausted`                      | next connection; a daily quota cools down until 00:00 UTC                         |
| 503, 529, "overloaded"               | `capacity`                             | next connection; 5 s cooldown                                                     |
| other 5xx, timeout, network          | `server` / `network`                   | next connection; backoff starting at 5 s                                          |
| 401, 403                             | `auth`                                 | next connection; 2 min cooldown and a visible error in the dashboard              |
| 404, 400 about model or context size | `model_unavailable` / `context_length` | skip to the next **target** of the combo (no cooldown)                            |
| 400 for an invalid payload           | `bad_request`                          | stop and return the error to the client                                           |

Within one target, connections of the same provider are ordered by **priority** (lowest first);
with equal priority they take turns, least recently used first. A connection in cooldown is skipped
until it expires, and recovers on its own. For streaming, switching happens until the first event
is sent; after that the answer has already started reaching the client.

When a model refuses a request for being too long, the router remembers its input limit and the
chat shrinks the history budget accordingly (see [usage.md](usage.md)).

## Observability

Every request, including failures and fallbacks, appears under **Connections, Activity**, and token
totals are in **Usage** ([usage.md](usage.md)). The router also applies the
[privacy firewall](privacy.md) to the request before any provider sees it.

The domain code is in `apps/server/src/contexts/routing/domain` (error classifier, cooldown policy,
connection selector, model resolver); the loop is `application/route-chat-request.ts`. The design
rationale is in [ADR 0003](adr/0003-provider-routing-with-fallback-and-cooldown.md).
