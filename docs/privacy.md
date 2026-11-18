# Privacy firewall

Before any text leaves for an AI provider, Thinkflow replaces personal data with reversible codes
such as `[CPF_1]` or `[NOME_2]`. You see the real values; the model only sees the codes, and the
answer comes back restored.

## What is protected

- **All model calls**: chat, Data with AI, reports, history summaries, Agent mode, the editor
  assistants and the `/v1` gateway. The firewall sits in the router, so it covers local models
  (Ollama, LM Studio) too. See [routing.md](routing.md).
- **Not protected**: attached images and PDFs. The filter reads text only. Prefer the local OCR of
  the library ([library.md](library.md)) for such files.

The setting **Protect personal data** is on by default (Settings, "Privacidade da IA"); the
detection score threshold is configurable there as well.

## How it works

1. A request is deep-copied and every text part (system prompt, messages, tool results) is scanned.
2. Detectors find spans: the native ones cover CPF, CNPJ (with check digits), CNS, PIS, voter ID
   (`TITULO`), CNH, RENAVAM, card numbers, e-mail, phone, CEP, RG, vehicle plates, names (from a list
   of first names); the optional Presidio sidecar adds names and addresses in free text.
3. Each span becomes a token. The same value always gets the same token inside a **scope** (a
   conversation, a report or a single request), so the model can reason about repeated values.
4. The answer, including streamed output, is restored before it reaches you.

The mapping lives in a **vault** per scope, stored in SQLite with the values encrypted
(AES-256-GCM); values are deduplicated through a keyed hash, so the clear value never sits in an
index. A vault is deleted together with the conversation or report it belongs to.

In Data with AI, new columns go through a review: for each you choose to **reveal** the real
values, **tokenize** them (you still see the real value) or **omit** the column, and the decision
can be remembered per column ([data-ai.md](data-ai.md)).

Detection is heuristic. Treat it as a strong mitigation, not as a guarantee, and avoid sending
data you are not allowed to process.

## Presidio sidecar (optional)

[Presidio](https://microsoft.github.io/presidio/) with the spaCy model `pt_core_news_lg` and the
Brazilian recognizers of [tarja-presidio](https://github.com/macmaia/tarja) finds names and
addresses in free text ("maria aparecida souza") that the native detectors miss.

```bash
docker compose --profile privacy up -d --build
```

Then set "Presidio URL" to `http://presidio:3000` in Settings, or set
`PRIVACY_PRESIDIO_URL=http://presidio:3000` in the environment.

- **Cost**: an image of about 1.5 GB and 1 to 2 GB of RAM; the first start takes about a minute.
- The service is not published on the host: only Thinkflow reaches it, over the Compose network.
  To reach it from `pnpm dev`, use a local, untracked `docker-compose.override.yml` that exposes
  port 3000 on loopback.
- If Presidio is down or takes more than a couple of seconds, the call continues with the native
  detectors only (nothing blocks) and the server logs a warning, at most once a minute and never
  with values. The "Test" button in Settings shows whether it is connected.

## Prototypes and captured screens

Screens captured for prototypes are scrubbed on capture: field values and grid body cells are
cleared and what remains is checked by the same detectors, so personal data of the screen itself
becomes a fictitious value ([prototypes.md](prototypes.md)).
