import { detectMermaidHeader, repairMermaidSource } from '@thinkflow/shared';

export const DIAGRAM_REPAIR_SYSTEM_PROMPT = [
  'Você corrige diagramas Mermaid com erro de sintaxe.',
  'Responda SOMENTE com o código Mermaid corrigido, sem cercas de código e sem comentários.',
  'Preserve o significado e os rótulos originais; mantenha o tipo do diagrama.',
  'IDs de nós em ASCII sem espaços; rótulos sempre entre aspas duplas; sem ponto e vírgula no fim das linhas.',
].join(' ');

export function buildDiagramRepairMessages(
  code: string,
  error: string,
): { role: 'system' | 'user'; content: string }[] {
  const err = error.trim()
    ? `\n\nErro informado pelo Mermaid:\n${error.trim().slice(0, 1_500)}`
    : '';
  return [
    { role: 'system', content: DIAGRAM_REPAIR_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Corrija este diagrama Mermaid:\n<diagrama>\n${code}\n</diagrama>${err}`,
    },
  ];
}

/** Extracts a plausible Mermaid source from a model answer, or null when none is recognisable. */
export function extractRepairedDiagram(answer: string): string | null {
  let text = answer.trim();
  const fenced = /```[a-zA-Z]*\s*\n([\s\S]*?)```/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  else
    text = text
      .replace(/^```[a-zA-Z]*\s*\n?/, '')
      .replace(/```$/, '')
      .trim();
  if (!text) return null;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => detectMermaidHeader(l) !== null);
  if (start < 0) return null;
  const { code } = repairMermaidSource(lines.slice(start).join('\n'));
  const trimmed = code.trim();
  return trimmed.split('\n').length >= 2 ? trimmed : null;
}

/** Fixed-window limiter (per process): at most `max` repairs per `windowMs`. */
export class RepairRateLimiter {
  private stamps: number[] = [];
  constructor(
    private readonly max = 20,
    private readonly windowMs = 60_000,
  ) {}
  tryTake(now: number): boolean {
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(now);
    return true;
  }
}
