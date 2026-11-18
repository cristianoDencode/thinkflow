/**
 * Picks a usable chat model from a provider's live model list. Used when a target
 * is "auto" or when the configured model no longer exists upstream.
 *
 * Texto apenas (voz/áudio/imagem fora do escopo por decisão do usuário): a model is eligible
 * only when it does not look like TTS/speech, transcription, audio/realtime, image/video
 * generation, embeddings/rerank or moderation/guard.
 */
const NON_CHAT_RE = new RegExp(
  [
    // speech / voice / audio
    'orpheus|playai|tts|speech|voice|sonic|whisper|transcri|audio|realtime',
    // live / bidirectional streaming (WebSocket) and computer-use models do not serve chat completions
    '(^|[-_/])live([-_]|$)|bidi|computer-use',
    // image / video generation
    'image|dall-e|imagen|flux|stable-diffusion|sdxl|veo|clip|vision-preview|ocr',
    // embeddings / rerank / moderation / guards
    'embed|rerank|moderation|guard|safeguard|safety|aqa',
  ].join('|'),
  'i',
);

const GEMINI_FLASH_RE = /gemini-?(\d+)(?:\.(\d+))?-flash(?!-lite)/i;
const UNSTABLE_RE = /preview|exp(erimental)?\b|-\d{2}-\d{2}\b|-\d{3}\b/i;

/**
 * Newest stable Gemini flash: highest version among non-preview models first, previews only when
 * no stable one exists. `-lite` variants are left to the generic fallback below.
 */
function newestGeminiFlash(candidates: string[]): string | undefined {
  const parsed = candidates.flatMap((name) => {
    const hit = GEMINI_FLASH_RE.exec(name);
    if (!hit) return [];
    return [
      {
        name,
        version: Number(hit[1]) * 1000 + Number(hit[2] ?? 0),
        stable: !UNSTABLE_RE.test(name),
      },
    ];
  });
  parsed.sort((a, b) => Number(b.stable) - Number(a.stable) || b.version - a.version);
  return parsed[0]?.name;
}

type Preference = RegExp | ((candidates: string[]) => string | undefined);

const PREFERENCES: Preference[] = [
  /llama-?3\.3.*70b/i,
  /llama-?4.*(maverick|scout)/i,
  /gpt-oss-120b/i,
  /gpt-oss-20b/i,
  /qwen-?3.*(235|32)b/i,
  /kimi-k2/i,
  /deepseek.*(v3|r1)/i,
  newestGeminiFlash,
  /gemini.*flash(?!-lite)/i,
  /gemini.*flash/i,
  /qwen.*(3|2\.5).*(235|72|32)b/i,
  /llama-?3\.1.*70b/i,
  /mistral-(small|medium|large)/i,
  /gpt-4\.1(-mini)?\b|gpt-4o(-mini)?\b/i,
  /claude/i,
  /70b|120b|72b|32b/i,
  /llama|qwen|mistral|gemma|gpt|deepseek/i,
];

/** True when the model name does not look like a non-text (voice/image/embedding/live...) model. */
export const isTextChatModel = (model: string): boolean => !NON_CHAT_RE.test(model);

const sizeOf = (m: string): number => {
  const hit = /(\d+(?:\.\d+)?)b\b/i.exec(m);
  return hit ? Number(hit[1]) : 0;
};

/**
 * With `needsTools`, only models matching the preference list are returned (an unknown model
 * may not support tool calling); otherwise the rest are a fallback, larger-looking first.
 */
export function pickAutoModel(
  models: string[],
  exclude: string[] = [],
  needsTools = false,
): string | null {
  const candidates = models.filter((m) => !exclude.includes(m) && !NON_CHAT_RE.test(m));
  for (const pref of PREFERENCES) {
    const hit =
      typeof pref === 'function' ? pref(candidates) : candidates.find((m) => pref.test(m));
    if (hit) return hit;
  }
  if (needsTools) return null;
  return [...candidates].sort((a, b) => sizeOf(b) - sizeOf(a))[0] ?? null;
}

export const isAutoModel = (model: string): boolean => /^(auto|\*)?$/i.test(model.trim());
