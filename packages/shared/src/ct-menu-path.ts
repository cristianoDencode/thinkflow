import type { TestLocator, TestStep } from './tests';

/*
 * Menu path suggestion. In the e-Cidade desktop menu a person reaches a screen by clicking, in the
 * top frame, on the institution (`instituicao_N`), the area (`area_N`, "DB:FINANCEIRO"), the
 * module (`modulo_N`, "Empenho") and then menu items (`#menu_id_N`, "Consultas" > "Consulta
 * Empenho"), usually after the "MENU" button ("Menu Principal"). The recorder stores those clicks
 * as ordinary steps; this module recognises such runs so the Passos tab can offer a one-click
 * comment: "Após a correção, acessa o menu: DB:FINANCEIRO > Empenho > Consultas > Consulta Empenho".
 */

export type MenuLevel = 'button' | 'institution' | 'area' | 'module' | 'item';

export interface MenuPathSuggestion {
  /** First step of the run (where the suggestion is offered). */
  stepId: string;
  /** Clicked labels, outermost first. */
  path: string[];
  /** Ready-to-use comment. */
  text: string;
}

const PREFIX = 'Após a correção, acessa o menu: ';
export const MENU_PATH_SEPARATOR = ' > ';

/**
 * Selector fragments that identify each level: the container ids (`#areas`, `#modulos`,
 * `#instituicoes`), the `<level>_N` ids/classes, or `#menu_id_N` for the menu items.
 */
const token = (name: string) => new RegExp(`(?:^|[#.\\s>"'=\\[])${name}(?![\\w-])`, 'i');
const SELECTOR_LEVELS: [MenuLevel, RegExp][] = [
  ['institution', token('instituic(?:ao|oes)(?:_\\d+)?')],
  ['area', token('area(?:s|_\\d+)')],
  ['module', token('modulo(?:s|_\\d+)')],
  ['item', /#menu_id_\d+|\.menu_id_\d+|#menu\s*>\s*\S/i],
];

const BUTTON_TEXT = /^menu(?: principal)?$/i;

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The text a click targeted: the text locator, else the quoted label of its description. */
function clickedText(step: TestStep): string {
  const target = step.target;
  if (!target) return '';
  const byLocator = target.locators.find(
    (l): l is Extract<TestLocator, { kind: 'text' | 'title' }> =>
      l.kind === 'text' || l.kind === 'title',
  );
  if (byLocator?.kind === 'text') return clean(byLocator.text);
  const quoted = /"([^"]+)"/.exec(target.description);
  if (quoted) return clean(quoted[1]!);
  const role = target.locators.find((l) => l.kind === 'role');
  if (role?.kind === 'role' && role.name) return clean(role.name);
  return byLocator ? clean(byLocator.text) : '';
}

/** Which menu level a step is, or null when it is not a top-frame menu click. */
export function menuLevelOf(step: TestStep): MenuLevel | null {
  if ((step.kind !== 'click' && step.kind !== 'dblclick') || !step.target) return null;
  if (step.target.frameUrl) return null; // the menu lives in the top frame
  const locators = step.target.locators;
  for (const locator of locators) {
    if (locator.kind !== 'css') continue;
    if (/^#menu$/i.test(locator.selector.trim())) return 'button';
    for (const [level, pattern] of SELECTOR_LEVELS) {
      if (pattern.test(locator.selector)) return level;
    }
  }
  // the "MENU" button has no stable class: its title or text gives it away
  const buttonLike = locators.some(
    (l) =>
      (l.kind === 'title' && /^menu principal$/i.test(clean(l.text))) ||
      (l.kind === 'text' && BUTTON_TEXT.test(clean(l.text))) ||
      (l.kind === 'role' && BUTTON_TEXT.test(clean(l.name))),
  );
  return buttonLike ? 'button' : null;
}

/** Order inside a path: institution, area, module, then items (any number of them). */
const ORDER: Record<MenuLevel, number> = { button: 0, institution: 1, area: 2, module: 3, item: 4 };

/**
 * Finds runs of consecutive menu clicks. A run needs at least a module or an item and two labels.
 * The institution comes from the run or, when the run starts at the area, from the last
 * institution click recorded earlier in the session.
 */
export function detectMenuPaths(steps: readonly TestStep[]): MenuPathSuggestion[] {
  const suggestions: MenuPathSuggestion[] = [];
  let lastInstitution = '';
  let run: { step: TestStep; level: MenuLevel; label: string }[] = [];

  const flush = () => {
    const first = run[0];
    const clicks = run.filter((r) => r.level !== 'button');
    const hasDepth = clicks.some((r) => r.level === 'module' || r.level === 'item');
    if (first && hasDepth) {
      const path: string[] = [];
      const hasInstitution = clicks.some((r) => r.level === 'institution' && r.label);
      if (!hasInstitution && lastInstitution) path.push(lastInstitution);
      for (const r of clicks) if (r.label) path.push(r.label);
      if (path.length >= 2) {
        suggestions.push({
          stepId: first.step.id,
          path,
          text: `${PREFIX}${path.join(MENU_PATH_SEPARATOR)}`,
        });
      }
    }
    for (const r of run) if (r.level === 'institution' && r.label) lastInstitution = r.label;
    run = [];
  };

  for (const step of steps) {
    const level = menuLevelOf(step);
    if (!level) {
      flush();
      continue;
    }
    const previous = run.at(-1);
    // a level that goes back up (a new area after a module) starts another run
    if (previous && ORDER[level] < ORDER[previous.level]) flush();
    run.push({ step, level, label: clickedText(step) });
  }
  flush();
  return suggestions;
}

/** Suggestion by the step it is offered on. */
export function menuPathByStep(steps: readonly TestStep[]): Map<string, MenuPathSuggestion> {
  return new Map(detectMenuPaths(steps).map((s) => [s.stepId, s]));
}
