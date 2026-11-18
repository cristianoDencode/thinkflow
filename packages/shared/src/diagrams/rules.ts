/**
 * Rules appended (pt-BR) to every system prompt that may produce diagrams. Keep it short: it is
 * paid on every request. The normalizer repairs what models still get wrong.
 */
export const DIAGRAM_PROMPT_RULES: string = [
  'Diagramas: quando um diagrama ajudar (fluxos, sequências, modelo de dados), use **somente Mermaid** em bloco ```mermaid',
  '(tipos: flowchart, sequenceDiagram, erDiagram, stateDiagram-v2, classDiagram, gantt).',
  'IDs de nós em ASCII sem espaços; rótulos sempre entre aspas, ex.: `A["Calcula juros (art. 5º)"]`;',
  'não use `end` como ID; sem ponto e vírgula no fim das linhas; no máximo ~25 nós.',
  'Nunca desenhe fluxos em ASCII-art.',
].join(' ');
