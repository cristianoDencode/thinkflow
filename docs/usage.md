# Usage, history and context

## Usage and estimates

The **Usage** page (user menu) shows how many tokens the router consumed this month, where they
came from and how much is projected per day, week, month and year.

- **What is measured**: every request through the router (chat, agent, `/v1`, reports, summaries,
  OCR and so on), with input and output tokens as reported by the provider. Failures count as a
  request without tokens.
- **Monthly reset**: the month runs from day 1 at 00:00 to the last day, in the server's time zone.
  Previous months stay available in the selector.
- **Storage**: the `usage_daily` table has one row per day, provider, model and origin. It is
  separate from `request_logs`, which keeps only the last 5,000 requests. History is kept for 13
  months.
- **Projections**: daily average = month tokens divided by elapsed days (days without use count);
  weekly = average x 7; yearly = average x 365; monthly = tokens so far + average x remaining days
  (past months show the real total). In the first 2 days of a month the average uses the latest
  days with use (up to 7).
- **Estimated tokens**: when a provider reports no usage, input is estimated (about 4 characters per
  token) and output counts as 0; the page shows how many requests were estimated.
- **Budget**: optional, in tokens per month (`PUT /api/usage/budget` with
  `{ "monthlyTokens": 5000000 }`; `0` removes it). The page compares usage and projection with the
  budget and warns if the projection exceeds it.
- **API** (session required): `GET /api/usage?month=YYYY-MM` (default: current month) returns
  totals, days, breakdowns by provider, model and origin, the projection and the budget;
  `GET /api/usage/months` lists months with data.

## History and context

Every conversation (chat or agent) is saved and can be resumed. Thinkflow also limits how much
history goes to the model, so long conversations do not overflow the context window.

- **History page**: search by title or message content; each conversation shows its **origin**
  (Ask AI, Document, Agent, Data with AI and its connection) and the library used. Filter by
  origin, database connection, **period** of last activity and pinned only; rename, pin, delete
  and open. Forked conversations get a "Derivada" badge.
- **What is stored**: messages, tool calls with output (up to 20,000 characters each), up to
  20,000 characters of each text attachment and, in agent mode, the folder and permission mode.
  Attached images are **not** stored (only name and type). A stored answer is capped at 200,000
  characters and a conversation at 2,000 messages (then use **Fork**).
- **Context budget**: 16,000 estimated tokens per request by default (about 4 characters per
  token), including system prompt, tools and the current message. If the router has learned the
  model's input limit from earlier `context_length` errors, the budget is capped at 85% of it. If
  the provider still refuses for size, the request is retried once with half the budget.
- **Incremental summary**: when history no longer fits (or exceeds twice the recent turns), old
  messages are compacted down to about 60% of the budget, keeping the latest turns verbatim, and
  become a summary. Only what is new is summarized each time. The summary uses the "Summary model"
  setting (default: the conversation's model) and falls back to a local extractive summary. The
  call shows up in Usage with the origin `summary`. Old tool calls enter the context as compact
  text. The summary applies to chat and agent mode and can be viewed in the conversation.
- **Fork**: the button on an assistant answer creates a new conversation from that point, with the
  last turns (up to 3) and a summary of the rest. The original is untouched.
- **Agent mode and resuming**: the Claude Code session is resumed while the working folder and
  the model stay the same. If the session is gone, the agent continues from a conversation
  summary. Changing model or folder starts a new session seeded with that summary and the latest
  turns. The Claude Code auto-compactor is not tuned (its window variable only accepts 100k to 1M
  tokens, which does not suit small models); use **Fork** when an agent conversation gets too big.
- **Retention**: `maxConversations` (default 500) applies when creating conversations: the oldest
  unpinned ones are deleted; pinned ones are never removed (but count toward the limit). Agent
  transcripts in `~/.claude/projects` are removed with them (best effort).
- **API** (session required):
  - `GET /api/conversations?q=&mode=&origin=&databaseId=&from=&to=&pinned=&limit=&offset=` lists
    and searches (`origin`: `chat`, `document`, `agent` or `data`; `from` and `to` are epoch ms of
    last activity);
  - `GET /api/conversations/:id` returns the conversation with messages and summary;
  - `PATCH /api/conversations/:id` renames (`title`) and pins (`pinned`);
  - `POST /api/conversations/:id/fork` with `{ "messageId": "...", "title": "..." }` (an assistant
    message) creates the fork;
  - `DELETE /api/conversations/:id` deletes.
- **Settings, "History and context"** (`PUT /api/settings`, key `history`): `contextBudgetTokens`
  (2,000 to 1,000,000; default 16,000), `recentTurns` (1 to 50; default 6), `summaryModel` (empty =
  the conversation's) and `maxConversations` (10 to 10,000; default 500).
