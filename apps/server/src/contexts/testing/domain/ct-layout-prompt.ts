import {
  CT_LAYOUT_FONTS,
  CT_LAYOUT_LIMITS,
  ctLayoutSchema,
  type CtLayout,
} from '@thinkflow/shared';

/*
 * Prompt and answer handling of "Criar modelo com IA": the model only designs the LOOK of the CT
 * document (title, texts, colors, font, header / footer). Categories (sections, fields) are fixed,
 * and the logo is never produced by the AI: it is only ever the one the person uploaded.
 */

export function buildLayoutSystemPrompt(): string {
  return [
    'Você cria MODELOS VISUAIS para o documento "Caso de Teste" (um documento técnico de testes de software em A4).',
    'Você define SOMENTE a aparência: título, linha acima do título, texto do cabeçalho, texto do rodapé, cores e fonte. ' +
      'As categorias do documento (seções, campos, tabelas e seus rótulos) são fixas e você NÃO as altera. ' +
      'Você não escreve HTML nem CSS e não cria nem descreve logotipos (o logotipo é enviado pela pessoa).',
    'Responda SOMENTE com um objeto JSON válido (sem texto fora do JSON) neste formato:',
    `{
  "name": "nome curto do modelo",
  "explanation": "uma frase dizendo o que foi feito",
  "layout": {
    "title": "título grande do documento (até ${CT_LAYOUT_LIMITS.maxTitleChars} caracteres)",
    "kicker": "linha pequena acima do título; \\"\\" para nenhuma (até ${CT_LAYOUT_LIMITS.maxKickerChars})",
    "headerText": "texto do cabeçalho da página; \\"\\" para nenhum (até ${CT_LAYOUT_LIMITS.maxHeaderChars})",
    "footerText": "texto do rodapé antes de \\"Página X de Y\\"; \\"\\" para nenhum (até ${CT_LAYOUT_LIMITS.maxFooterChars})",
    "primaryColor": "#RRGGBB (números de seção e linha acima do título)",
    "accentColor": "#RRGGBB (status dos casos de uso)",
    "fontFamily": "${CT_LAYOUT_FONTS.join(' | ')}",
    "logoPosition": "left | right",
    "showHeader": true,
    "showFooter": true
  }
}`,
    'Regras: use cores com contraste suficiente sobre fundo branco (texto legível); escreva em português do Brasil; ' +
      'não invente nome de empresa, órgão ou pessoa que a pessoa não tenha citado; se pedirem para refinar um modelo, mude só o que foi pedido e mantenha o resto.',
  ].join('\n\n');
}

/** The user turn: the wish, plus the current look (without the logo bytes) when refining. */
export function buildLayoutUserPrompt(description: string, current: CtLayout | undefined): string {
  const parts = [`<pedido>\n${description}\n</pedido>`];
  if (current) {
    const { logo, ...rest } = current;
    parts.push(
      `Modelo atual a refinar (${logo ? 'tem logotipo, que será mantido' : 'sem logotipo'}):\n${JSON.stringify(rest, null, 2)}`,
    );
  }
  return parts.join('\n\n');
}

function fixColor(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const v = value.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(v)) return `#${[...v].map((ch) => ch + ch).join('')}`;
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v}`;
  return value;
}

function fixFont(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const wanted = value.trim().toLowerCase();
  return CT_LAYOUT_FONTS.find((font) => font.toLowerCase() === wanted) ?? value;
}

function clip(value: unknown, max: number): unknown {
  return typeof value === 'string' ? value.trim().slice(0, max) : value;
}

export type LayoutDraft =
  | { ok: true; name: string; layout: CtLayout; explanation: string }
  | { ok: false; issues: string[] };

/**
 * Turns the model's JSON into a validated layout. Missing fields keep `base` (the layout being
 * refined, or the defaults); the logo always comes from `base`, whatever the model wrote.
 */
export function layoutFromJson(json: Record<string, unknown>, base: CtLayout): LayoutDraft {
  const raw =
    json.layout && typeof json.layout === 'object' && !Array.isArray(json.layout)
      ? (json.layout as Record<string, unknown>)
      : json;
  const candidate: Record<string, unknown> = { ...base, ...raw, logo: base.logo };
  candidate.primaryColor = fixColor(candidate.primaryColor);
  candidate.accentColor = fixColor(candidate.accentColor);
  candidate.fontFamily = fixFont(candidate.fontFamily);
  candidate.title = clip(candidate.title, CT_LAYOUT_LIMITS.maxTitleChars);
  candidate.kicker = clip(candidate.kicker, CT_LAYOUT_LIMITS.maxKickerChars);
  candidate.headerText = clip(candidate.headerText, CT_LAYOUT_LIMITS.maxHeaderChars);
  candidate.footerText = clip(candidate.footerText, CT_LAYOUT_LIMITS.maxFooterChars);
  const parsed = ctLayoutSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'layout'}: ${i.message}`),
    };
  }
  const name =
    typeof json.name === 'string' && json.name.trim()
      ? json.name.trim().slice(0, CT_LAYOUT_LIMITS.maxNameChars)
      : 'Novo modelo';
  const explanation =
    typeof json.explanation === 'string' ? json.explanation.trim().slice(0, 500) : '';
  return { ok: true, name, layout: parsed.data, explanation };
}
