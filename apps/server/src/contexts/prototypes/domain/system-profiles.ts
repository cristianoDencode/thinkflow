import {
  DEFAULT_SYSTEM_PROFILE_ID,
  SYSTEM_PROFILES,
  type SystemProfileDto,
} from '@thinkflow/shared';

/*
 * System profiles, server side: the prompt material of the prototype assistant that depends on the
 * legacy system being prototyped (persona, look, ready-made CSS classes). The assistant's own
 * instructions are generic; a profile adds "what this system looks like". e-Cidade is the first
 * built-in profile and the only one. Its CSS classes keep the `ec-` prefix (stored prototypes use
 * them).
 */

export interface PrototypeSystemProfile extends SystemProfileDto {
  /** One sentence naming the system and who uses it (goes after the generic persona). */
  persona: string;
  /** Compact description of the look, with the ready-made classes (read by the model). */
  styleGuide: string;
  /** Stylesheet of those classes; added to a screen's CSS when it uses them. */
  baseCss: string;
  /** Marker line of `baseCss`, so it is added once. */
  baseMarker: string;
  /** The screen uses the classes of `baseCss`. */
  usesBase(html: string): boolean;
  /** Class of the profile's data grids (hint of the "grid" quick action). */
  gridClass: string;
  /** What the optional MCP tools offer in this system (hint for the model). */
  toolsExample: string;
}

/** Marker of the base stylesheet, so it is added once. */
export const ECIDADE_BASE_MARKER = '/* ec-base */';

/** Classes of the built-in e-Cidade look; added to the CSS automatically when a screen uses them. */
export const ECIDADE_BASE_CSS = `${ECIDADE_BASE_MARKER}
body{margin:0;background:#ccc;font:11px Arial,Helvetica,sans-serif;color:#000}
.ec-window{border:1px solid #666;background:#ccc}
.ec-titlebar{background:#2c5d9d;color:#fff;font:bold 12px Arial,Helvetica,sans-serif;padding:3px 6px}
.ec-content{padding:8px}
.ec-form fieldset{border:1px solid #999;background:#ccc;margin:0 0 8px;padding:6px 8px}
.ec-form legend{font-weight:bold;color:#000;padding:0 4px}
.ec-row{display:flex;gap:12px;align-items:center;margin:3px 0}
.ec-label{min-width:130px;font-weight:bold;text-align:right}
.ec-input{border:1px solid #7f9db9;background:#fff;font:11px Arial,Helvetica,sans-serif;padding:1px 3px;height:18px}
.ec-input[readonly]{background:#deb887}
.ec-buttons{text-align:center;padding:6px 0}
.ec-btn{font:11px Arial,Helvetica,sans-serif;padding:2px 12px;border:1px solid #666;background:#eee;cursor:pointer}
.ec-grid{border-collapse:collapse;width:100%;background:#fff}
.ec-grid th{background:#2c5d9d;color:#fff;font:bold 11px Arial,Helvetica,sans-serif;padding:3px 5px;border:1px solid #666;text-align:left}
.ec-grid td{border:1px solid #999;padding:2px 5px}
.ec-grid tr:nth-child(even) td{background:#f1f1f1}
`;

/** Compact description of the classic e-Cidade look (read by the model). */
export const ECIDADE_STYLE_GUIDE = [
  'Estilo e-Cidade clássico: fonte Arial/Verdana de 11 a 12px, fundo cinza (#ccc), fieldsets cinza com borda fina e legenda em negrito,',
  'rótulos em negrito à esquerda dos campos, campos de texto pequenos com borda azul-acinzentada, barra de título da janela em azul (#2c5d9d, texto branco),',
  'botões pequenos e centralizados em uma barra no rodapé do formulário, grades (tabelas) com cabeçalho azul e linhas zebradas.',
  'Classes prontas (o CSS delas é acrescentado automaticamente se você usá-las): ec-window, ec-titlebar, ec-content, ec-form, ec-row, ec-label, ec-input, ec-buttons, ec-btn, ec-grid.',
  'Exemplo: <div class="ec-window"><div class="ec-titlebar">Cadastro</div><div class="ec-content"><form class="ec-form"><fieldset><legend>Dados</legend><div class="ec-row"><span class="ec-label">Nome:</span><input class="ec-input" type="text" name="nome"></div></fieldset><div class="ec-buttons"><input class="ec-btn" type="button" value="Salvar"></div></form></div></div>',
].join('\n');

const ecidadeShared = SYSTEM_PROFILES.find((p) => p.id === 'ecidade')!;

/** e-Cidade, the municipal ERP: the first built-in profile. */
export const ECIDADE_PROFILE: PrototypeSystemProfile = {
  ...ecidadeShared,
  persona: 'O sistema é o e-Cidade, ERP municipal usado por prefeituras.',
  styleGuide: ECIDADE_STYLE_GUIDE,
  baseCss: ECIDADE_BASE_CSS,
  baseMarker: ECIDADE_BASE_MARKER,
  usesBase: (html) => /class\s*=\s*["'][^"']*\bec-/i.test(html),
  gridClass: 'ec-grid',
  toolsExample: 'o dicionário de dados/mapeamento do e-Cidade',
};

const PROFILES: readonly PrototypeSystemProfile[] = [ECIDADE_PROFILE];

/** The profile with that id; the default one (e-Cidade) when the id is unknown or absent. */
export function getSystemProfile(id?: string | null): PrototypeSystemProfile {
  const wanted = (id ?? '').trim().toLowerCase();
  return (
    PROFILES.find((p) => p.id === wanted) ??
    PROFILES.find((p) => p.id === DEFAULT_SYSTEM_PROFILE_ID) ??
    ECIDADE_PROFILE
  );
}

/** True when a profile exists for the id (an unknown `source.system` falls back to heuristics). */
export const hasSystemProfile = (id: string | null | undefined): boolean =>
  PROFILES.some((p) => p.id === (id ?? '').trim().toLowerCase());
