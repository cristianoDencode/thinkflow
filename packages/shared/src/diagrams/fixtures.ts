/**
 * Real-world bad (and good) samples for the Mermaid normalizer, with the exact expected output.
 * `output === input` means the sample must be left byte-identical.
 */
export interface DiagramFixture {
  name: string;
  input: string;
  output: string;
  /** Fix codes that must appear on the first detected diagram. */
  fixes?: string[];
  /** Expected kind of the first detected diagram (omit when no diagram is expected). */
  kind?: string;
  /** Number of diagrams expected (default: 1 when `kind` is set, otherwise 0). */
  diagrams?: number;
}

const F = '```';

/** NotebookLM answer: unfenced flowchart, pt-BR accents, parentheses in labels, citation markers. */
export const NOTEBOOKLM_UNFENCED = [
  'O fluxo de cálculo pode ser representado assim:',
  'flowchart TD',
  '    A[Início: fc_calcula(numpre, numpar)] --> B{Débito existe?} [1]',
  '    B -- Sim --> C[Calcula correção (IPCA-E)]',
  '    B -- Não --> Z[Retorna código 1]',
  '    C --> D[Calcula juros & multa]',
  '    D --> E[Aplica desconto]; [2, 3]',
  'Esse fluxo mostra que o débito é recalculado a cada parcela.',
].join('\n');

export const NOTEBOOKLM_UNFENCED_EXPECTED = [
  'O fluxo de cálculo pode ser representado assim:',
  `${F}mermaid`,
  'flowchart TD',
  '    A["Início: fc_calcula(numpre, numpar)"] --> B{"Débito existe?"}',
  '    B -- Sim --> C["Calcula correção (IPCA-E)"]',
  '    B -- Não --> Z["Retorna código 1"]',
  '    C --> D["Calcula juros & multa"]',
  '    D --> E[Aplica desconto]',
  F,
  'Esse fluxo mostra que o débito é recalculado a cada parcela.',
].join('\n');

const VALID_MERMAID = [
  'Segue o diagrama:',
  '',
  `${F}mermaid`,
  'flowchart LR',
  '    A["Início"] --> B{"Débito existe?"}',
  '    B -->|"Sim"| C["Calcula (IPCA-E)"]',
  '    B -->|"Não"| D["Fim"]',
  F,
  '',
  'Pronto.',
].join('\n');

const ASCII_BOX = [
  'Arquitetura:',
  '',
  F,
  '┌──────────┐     ┌──────────┐',
  '│ Cliente  │ --> │ Servidor │',
  '└──────────┘     └──────────┘',
  F,
].join('\n');

const ASCII_PLUS = [
  F,
  '+--------+',
  '| Passo  |',
  '+--------+',
  '    |',
  '    v',
  '+--------+',
  F,
].join('\n');

export const FIXTURES: DiagramFixture[] = [
  {
    name: 'NotebookLM unfenced flowchart (pt-BR, accents, parentheses, citations)',
    input: NOTEBOOKLM_UNFENCED,
    output: NOTEBOOKLM_UNFENCED_EXPECTED,
    kind: 'flowchart',
    fixes: ['unfenced', 'citations', 'trailing-semicolon', 'quote-label'],
  },
  {
    name: 'fence labeled flowchart without header',
    input: [`${F}flowchart`, 'A --> B', F].join('\n'),
    output: [`${F}mermaid`, 'flowchart TD', 'A --> B', F].join('\n'),
    kind: 'flowchart',
    fixes: ['relabel-fence', 'add-header'],
  },
  {
    name: 'fence "graph LR" with smart quotes in a label',
    input: [`${F}graph LR`, 'A[Diz “olá”] --> B[‘ok’]', F].join('\n'),
    output: [`${F}mermaid`, 'graph LR', 'A["Diz #quot;olá#quot;"] --> B[\'ok\']', F].join('\n'),
    kind: 'flowchart',
    fixes: ['relabel-fence', 'add-header', 'smart-quotes', 'quote-label'],
  },
  {
    name: 'HTML-escaped arrow',
    input: [`${F}mermaid`, 'flowchart TD', 'A --&gt; B', F].join('\n'),
    output: [`${F}mermaid`, 'flowchart TD', 'A --> B', F].join('\n'),
    kind: 'flowchart',
    fixes: ['html-entities'],
  },
  {
    name: 'broken arrows (A - -> B, A -> B, A → B, A –> B, A -- > B, A = => B)',
    input: [
      `${F}mermaid`,
      'flowchart TD',
      'A - -> B',
      'B -> C',
      'C → D',
      'D –> E',
      'E -- > F',
      'F = => G',
      F,
    ].join('\n'),
    output: [
      `${F}mermaid`,
      'flowchart TD',
      'A --> B',
      'B --> C',
      'C --> D',
      'D --> E',
      'E --> F',
      'F ==> G',
      F,
    ].join('\n'),
    kind: 'flowchart',
    fixes: ['arrows'],
  },
  {
    name: 'lowercase end used as a node id',
    input: [`${F}mermaid`, 'flowchart TD', 'A --> end', F].join('\n'),
    output: [`${F}mermaid`, 'flowchart TD', 'A --> endNode["end"]', F].join('\n'),
    kind: 'flowchart',
    fixes: ['end-id'],
  },
  {
    name: 'subgraph closing end is left alone',
    input: [
      `${F}mermaid`,
      'flowchart TD',
      '    subgraph S1[Etapa um]',
      '        A --> B',
      '    end',
      '    B --> C',
      F,
    ].join('\n'),
    output: [
      `${F}mermaid`,
      'flowchart TD',
      '    subgraph S1[Etapa um]',
      '        A --> B',
      '    end',
      '    B --> C',
      F,
    ].join('\n'),
    kind: 'flowchart',
  },
  {
    name: 'unfenced sequenceDiagram with semicolons',
    input: [
      'Veja:',
      'sequenceDiagram',
      '    participant U as Usuário',
      '    U->>Sistema: envia; valida;',
      '    Sistema-->>U: ok',
      '',
      'Fim.',
    ].join('\n'),
    output: [
      'Veja:',
      `${F}mermaid`,
      'sequenceDiagram',
      '    participant U as Usuário',
      '    U->>Sistema: envia#59; valida',
      '    Sistema-->>U: ok',
      F,
      '',
      'Fim.',
    ].join('\n'),
    kind: 'sequenceDiagram',
    fixes: ['unfenced', 'trailing-semicolon', 'sequence-semicolon'],
  },
  {
    name: 'unfenced erDiagram with trailing semicolons and inline attribute block',
    input: [
      'erDiagram',
      '    CLIENTE ||--o{ DEBITOS : possui;',
      '    DEBITOS { int k00_numpre string nome PK };',
    ].join('\n'),
    output: [
      `${F}mermaid`,
      'erDiagram',
      '    CLIENTE ||--o{ DEBITOS : possui',
      '    DEBITOS {',
      '        int k00_numpre',
      '        string nome PK',
      '    }',
      F,
    ].join('\n'),
    kind: 'erDiagram',
    fixes: ['unfenced', 'trailing-semicolon', 'er-inline-attributes'],
  },
  {
    name: 'ER relationship label with spaces gets quoted',
    input: [`${F}mermaid`, 'erDiagram', 'CLIENTE ||--o{ PEDIDO : faz pedido', F].join('\n'),
    output: [`${F}mermaid`, 'erDiagram', 'CLIENTE ||--o{ PEDIDO : "faz pedido"', F].join('\n'),
    kind: 'erDiagram',
    fixes: ['er-relationship-label'],
  },
  {
    name: 'ASCII box-drawing diagram in an unlabeled fence is untouched',
    input: ASCII_BOX,
    output: ASCII_BOX,
  },
  {
    name: 'ASCII +---+ diagram in a ```text fence is untouched',
    input: ASCII_PLUS.replace(F, `${F}text`),
    output: ASCII_PLUS.replace(F, `${F}text`),
  },
  {
    name: 'valid mermaid block is byte-identical',
    input: VALID_MERMAID,
    output: VALID_MERMAID,
    kind: 'flowchart',
    fixes: [],
  },
  {
    name: '4-space indented flowchart becomes a fence',
    input: ['Exemplo:', '', '    flowchart LR', '    A --> B', '    B --> C', '', 'Fim.'].join(
      '\n',
    ),
    output: [
      'Exemplo:',
      '',
      `${F}mermaid`,
      'flowchart LR',
      'A --> B',
      'B --> C',
      F,
      '',
      'Fim.',
    ].join('\n'),
    kind: 'flowchart',
    fixes: ['indented-code'],
  },
  {
    name: 'bulleted NotebookLM lines',
    input: ['- flowchart TD', '- A --> B', '- B --> C'].join('\n'),
    output: [`${F}mermaid`, 'flowchart TD', 'A --> B', 'B --> C', F].join('\n'),
    kind: 'flowchart',
    fixes: ['unfenced', 'list-markers'],
  },
  {
    name: 'zero-width characters and NBSP',
    input: [`${F}mermaid`, 'flowchart TD', 'A​ --> B', F].join('\n'),
    output: [`${F}mermaid`, 'flowchart TD', 'A --> B', F].join('\n'),
    kind: 'flowchart',
    fixes: ['zero-width', 'nbsp'],
  },
  {
    name: 'CRLF document',
    input: [`${F}mermaid`, 'flowchart TD', 'A --> B;', F].join('\r\n'),
    output: [`${F}mermaid`, 'flowchart TD', 'A --> B', F].join('\r\n'),
    kind: 'flowchart',
    fixes: ['crlf', 'trailing-semicolon'],
  },
  {
    name: 'graph TD with trailing semicolon',
    input: [`${F}mermaid`, 'graph TD;', 'A-->B;', F].join('\n'),
    output: [`${F}mermaid`, 'graph TD', 'A-->B', F].join('\n'),
    kind: 'flowchart',
    fixes: ['header', 'trailing-semicolon'],
  },
  {
    name: 'inner quotes inside a node label',
    input: [`${F}mermaid`, 'flowchart TD', 'A[Diz "olá"] --> B', F].join('\n'),
    output: [`${F}mermaid`, 'flowchart TD', 'A["Diz #quot;olá#quot;"] --> B', F].join('\n'),
    kind: 'flowchart',
    fixes: ['quote-label'],
  },
  {
    name: '```text fence with a flowchart header',
    input: [`${F}text`, 'flowchart LR', 'A --> B', F].join('\n'),
    output: [`${F}mermaid`, 'flowchart LR', 'A --> B', F].join('\n'),
    kind: 'flowchart',
    fixes: ['relabel-fence'],
  },
  {
    name: 'prose "graph theory" is not a diagram',
    input: 'graph theory explains how nodes connect.\nPie chart: 30%\nTimeline of events.',
    output: 'graph theory explains how nodes connect.\nPie chart: 30%\nTimeline of events.',
  },
  {
    name: 'python block mentioning "graph TD" is untouched',
    input: [`${F}python`, 'print("graph TD")', 'g = "flowchart TD"', F].join('\n'),
    output: [`${F}python`, 'print("graph TD")', 'g = "flowchart TD"', F].join('\n'),
  },
  {
    name: 'json block with a header-like first line is untouched',
    input: [`${F}json`, '{"graph": "TD"}', F].join('\n'),
    output: [`${F}json`, '{"graph": "TD"}', F].join('\n'),
  },
  {
    name: 'unclosed fence while streaming is untouched',
    input: ['Texto', `${F}mermaid`, 'flowchart TD', 'A --> B;'].join('\n'),
    output: ['Texto', `${F}mermaid`, 'flowchart TD', 'A --> B;'].join('\n'),
  },
  {
    name: 'header without a body is left alone',
    input: 'Fluxo:\nflowchart TD\n\nDepois explico.',
    output: 'Fluxo:\nflowchart TD\n\nDepois explico.',
  },
  {
    name: 'accented node ids get an ASCII id plus a label',
    input: [`${F}mermaid`, 'flowchart TD', 'Cálculo --> Fim', 'Fim --> Cálculo', F].join('\n'),
    output: [
      `${F}mermaid`,
      'flowchart TD',
      'Calculo["Cálculo"] --> Fim',
      'Fim --> Calculo',
      F,
    ].join('\n'),
    kind: 'flowchart',
    fixes: ['ascii-id'],
  },
  {
    name: 'edge labels with parentheses are quoted',
    input: [`${F}mermaid`, 'flowchart TD', 'A -->|Sim (ok)| B', 'B -- Não (erro) --> C', F].join(
      '\n',
    ),
    output: [`${F}mermaid`, 'flowchart TD', 'A -->|"Sim (ok)"| B', 'B -->|"Não (erro)"| C', F].join(
      '\n',
    ),
    kind: 'flowchart',
    fixes: ['quote-edge-label'],
  },
  {
    name: 'blockquoted unfenced diagram',
    input: ['> flowchart TD', '> A --> B', '> B --> C', '', 'Texto.'].join('\n'),
    output: [`${F}mermaid`, 'flowchart TD', 'A --> B', 'B --> C', F, '', 'Texto.'].join('\n'),
    kind: 'flowchart',
    fixes: ['unfenced', 'blockquote'],
  },
  {
    name: 'stray "mermaid" label line before an unfenced diagram',
    input: ['mermaid', 'flowchart TD', 'A --> B'].join('\n'),
    output: [`${F}mermaid`, 'flowchart TD', 'A --> B', F].join('\n'),
    kind: 'flowchart',
    fixes: ['stray-mermaid-label'],
  },
  {
    name: 'diagram nested in a list item keeps its indentation',
    input: ['1. Passo um:', `   ${F}flowchart`, '   A[Início (x)] --> B', `   ${F}`].join('\n'),
    output: [
      '1. Passo um:',
      `   ${F}mermaid`,
      '   flowchart TD',
      '   A["Início (x)"] --> B',
      `   ${F}`,
    ].join('\n'),
    kind: 'flowchart',
  },
  {
    name: 'unfenced pie chart',
    input: ['pie title Débitos', '    "Pagos" : 70', '    "Abertos" : 30', '', 'Fim.'].join('\n'),
    output: [
      `${F}mermaid`,
      'pie title Débitos',
      '    "Pagos" : 70',
      '    "Abertos" : 30',
      F,
      '',
      'Fim.',
    ].join('\n'),
    kind: 'pie',
  },
  {
    name: 'mermaid fence with frontmatter and directive stays identical',
    input: [
      `${F}mermaid`,
      '---',
      'title: Fluxo',
      '---',
      '%%{init: {"theme": "neutral"}}%%',
      'flowchart TD',
      '    A --> B',
      F,
    ].join('\n'),
    output: [
      `${F}mermaid`,
      '---',
      'title: Fluxo',
      '---',
      '%%{init: {"theme": "neutral"}}%%',
      'flowchart TD',
      '    A --> B',
      F,
    ].join('\n'),
    kind: 'flowchart',
    fixes: [],
  },
  {
    name: 'two diagrams in one message',
    input: [
      'Primeiro:',
      'flowchart TD',
      '    A --> B',
      '',
      'Segundo:',
      `${F}sequence`,
      'U->>S: oi',
      F,
    ].join('\n'),
    output: [
      'Primeiro:',
      `${F}mermaid`,
      'flowchart TD',
      '    A --> B',
      F,
      '',
      'Segundo:',
      `${F}mermaid`,
      'sequenceDiagram',
      'U->>S: oi',
      F,
    ].join('\n'),
    kind: 'flowchart',
    diagrams: 2,
  },
];
