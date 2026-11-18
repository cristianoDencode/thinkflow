# Using Thinkflow from Claude Code and OpenAI clients

Thinkflow exposes an Anthropic- and OpenAI-compatible gateway under `/v1`. Clients that speak
those protocols can use your combos, with fallback, usage tracking and the privacy firewall.

| Endpoint                         | Protocol  |
| -------------------------------- | --------- |
| `POST /v1/messages`              | Anthropic |
| `POST /v1/messages/count_tokens` | Anthropic |
| `POST /v1/chat/completions`      | OpenAI    |
| `GET /v1/models`                 | both      |

Requests need a **router API key** (prefix `tf_`) sent as a bearer token. Create one in
**Settings, Router API keys**. The key is stored only as a hash.

## Claude Code (CLI and VS Code extension)

1. Create a router API key in Settings.
2. Copy the block that Settings shows into `~/.claude/settings.json` (on Windows,
   `%USERPROFILE%\.claude\settings.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3737",
    "ANTHROPIC_AUTH_TOKEN": "tf_...",
    "ANTHROPIC_MODEL": "thinkflow/default",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "thinkflow/default",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "thinkflow/default",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "thinkflow/default",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

3. Restart Claude Code or VS Code. Each request shows up in **Connections, Activity**.

If a client asks for `claude-sonnet-...`, `claude-opus-...` or `claude-haiku-...`, Thinkflow uses
the **model mapping** from Settings. Without a mapping it calls Anthropic directly when an
Anthropic connection exists, and otherwise falls back to the default alias.

> Claude Code relies heavily on tool calling. Put models that support tools in your combos; models
> without it answer, but cannot take actions.

## OpenAI clients

```bash
curl http://localhost:3737/v1/chat/completions \
  -H "Authorization: Bearer tf_..." -H "Content-Type: application/json" \
  -d '{"model":"thinkflow/default","messages":[{"role":"user","content":"Hello!"}]}'
```

Any OpenAI SDK works by setting its base URL to `http://localhost:3737/v1` and the API key to your
router key.

## Agent mode inside Thinkflow

The chat's **Agent** mode runs Claude Code itself through the Claude Agent SDK (tools, MCP, plan
mode) in a working folder you choose, with every model call going through the Thinkflow router.
The session is resumed while the folder and model stay the same. The "allow everything" permission
lets the agent run commands and edit files in that folder without asking: use it deliberately
(see [SECURITY.md](../SECURITY.md)).
