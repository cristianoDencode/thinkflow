/**
 * Tolerant JSON extraction for free models: they wrap JSON in prose or code fences, leave trailing
 * commas, use typographic quotes, add comments or get cut off by the token limit.
 */

function stripFences(text: string): string {
  const fenced = [...text.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)(?:```|$)/g)]
    .map((m) => m[1]!)
    .find((body) => body.includes('{'));
  return fenced ?? text;
}

/** From the first `{`, the balanced object text; when truncated, closes strings and brackets. */
function sliceObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  // truncated: drop a dangling escape, close the string and the open brackets
  let tail = text.slice(start);
  if (escaped) tail = tail.slice(0, -1);
  if (inString) tail += '"';
  return tail.replace(/,\s*$/, '') + stack.reverse().join('');
}

function repair(json: string): string {
  return json
    .replace(/[“”]/g, '"')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
}

/** The first JSON object found in a model answer, or null when none can be recovered. */
export function extractJsonObject(answer: string): Record<string, unknown> | null {
  const sliced = sliceObject(stripFences(answer));
  if (!sliced) return null;
  for (const candidate of [sliced, repair(sliced)]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {
      // try the next repair
    }
  }
  return null;
}
