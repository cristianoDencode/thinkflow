import { describe, expect, it } from 'vitest';
import {
  DIAGRAM_PROMPT_RULES,
  MERMAID_KEYWORDS,
  detectMermaidHeader,
  hashDiagram,
  looksLikeAsciiArt,
  normalizeDiagrams,
  repairMermaidSource,
} from './index';
import { FIXTURES, NOTEBOOKLM_UNFENCED, NOTEBOOKLM_UNFENCED_EXPECTED } from './fixtures';

describe('normalizeDiagrams fixtures', () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      const r = normalizeDiagrams(f.input);
      expect(r.text).toBe(f.output);
      const expectedCount = f.diagrams ?? (f.kind ? 1 : 0);
      expect(r.diagrams).toHaveLength(expectedCount);
      if (f.kind) expect(r.diagrams[0]?.kind).toBe(f.kind);
      for (const fix of f.fixes ?? []) expect(r.diagrams[0]?.fixes).toContain(fix);
      if (f.fixes && f.fixes.length === 0) expect(r.diagrams[0]?.fixes).toEqual([]);
    });

    it(`is idempotent: ${f.name}`, () => {
      const once = normalizeDiagrams(f.input);
      const twice = normalizeDiagrams(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.diagrams.map((d) => d.code)).toEqual(once.diagrams.map((d) => d.code));
    });
  }
});

describe('NotebookLM unfenced flowchart (acceptance)', () => {
  const r = normalizeDiagrams(NOTEBOOKLM_UNFENCED);

  it('fences the diagram and keeps the surrounding prose outside', () => {
    expect(r.text).toBe(NOTEBOOKLM_UNFENCED_EXPECTED);
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('O fluxo de cálculo pode ser representado assim:');
    expect(lines[1]).toBe('```mermaid');
    expect(lines[lines.length - 1]).toBe(
      'Esse fluxo mostra que o débito é recalculado a cada parcela.',
    );
  });

  it('removes citation markers and semicolons, quotes risky labels', () => {
    const d = r.diagrams[0];
    expect(d?.fenced).toBe(false);
    expect(d?.code).not.toMatch(/\[\d/);
    expect(d?.code).not.toContain(';');
    expect(d?.code).toContain('A["Início: fc_calcula(numpre, numpar)"]');
    expect(d?.code).toContain('B{"Débito existe?"}');
    expect(d?.code).toContain('C["Calcula correção (IPCA-E)"]');
    expect(d?.original).toContain('[2, 3]');
  });

  it('also works when the answer is wrapped in a bullet list or blockquote', () => {
    const bullet = NOTEBOOKLM_UNFENCED.replace('\nflowchart TD', '\n- flowchart TD');
    expect(normalizeDiagrams(bullet).diagrams[0]?.code).toContain('B{"Débito existe?"}');
  });
});

describe('detectMermaidHeader', () => {
  it('accepts strict headers', () => {
    expect(detectMermaidHeader('flowchart TD')).toBe('flowchart');
    expect(detectMermaidHeader('graph LR;')).toBe('flowchart');
    expect(detectMermaidHeader('  flowchart  ')).toBe('flowchart');
    expect(detectMermaidHeader('sequenceDiagram')).toBe('sequenceDiagram');
    expect(detectMermaidHeader('stateDiagram-v2')).toBe('stateDiagram-v2');
    expect(detectMermaidHeader('pie showData title Algo')).toBe('pie');
  });

  it('rejects prose and near misses', () => {
    expect(detectMermaidHeader('graph theory explains things')).toBeNull();
    expect(detectMermaidHeader('Pie chart: 30%')).toBeNull();
    expect(detectMermaidHeader('graph')).toBeNull();
    expect(detectMermaidHeader('timeline of events')).toBeNull();
    expect(detectMermaidHeader('')).toBeNull();
  });

  it('knows every keyword', () => {
    expect(MERMAID_KEYWORDS).toEqual(
      expect.arrayContaining(['flowchart', 'graph', 'sequenceDiagram', 'erDiagram', 'gantt']),
    );
  });
});

describe('looksLikeAsciiArt', () => {
  it('detects box drawing, +---+ and pipe/v connectors', () => {
    expect(looksLikeAsciiArt('┌──┐\n│ A│\n└──┘')).toBe(true);
    expect(looksLikeAsciiArt('+----+\n| A  |\n+----+')).toBe(true);
    expect(looksLikeAsciiArt('A\n |\n v\nB\n |\n v\nC')).toBe(true);
    expect(looksLikeAsciiArt('| a |\n| b |\n| c |')).toBe(true);
  });

  it('does not flag real Mermaid', () => {
    expect(looksLikeAsciiArt('flowchart TD\nA -->|x| B')).toBe(false);
    expect(looksLikeAsciiArt('erDiagram\nA ||--o{ B : has\nB ||--|| C : is')).toBe(false);
  });
});

describe('repairMermaidSource', () => {
  it('returns the kind and fixes', () => {
    const r = repairMermaidSource('graph TD;\nA -> B;');
    expect(r.kind).toBe('flowchart');
    expect(r.code).toBe('graph TD\nA --> B');
    expect(r.fixes).toEqual(expect.arrayContaining(['header', 'arrows', 'trailing-semicolon']));
  });

  it('reports kind null when there is no header and no default', () => {
    expect(repairMermaidSource('A --> B').kind).toBeNull();
    expect(repairMermaidSource('A --> B', 'flowchart TD').code).toBe('flowchart TD\nA --> B');
  });

  it('adds a default direction to a bare flowchart header', () => {
    expect(repairMermaidSource('flowchart\nA --> B').code).toBe('flowchart TD\nA --> B');
  });

  it('canonicalizes keyword case', () => {
    expect(repairMermaidSource('Flowchart lr\nA --> B').code).toBe('flowchart LR\nA --> B');
    expect(repairMermaidSource('sequencediagram\nA->>B: oi').kind).toBe('sequenceDiagram');
  });

  it('does not strip numeric node labels or ids', () => {
    const r = repairMermaidSource('flowchart TD\nA[1] --> B[2]\nC[[3]] --> D');
    expect(r.code).toBe('flowchart TD\nA[1] --> B[2]\nC[[3]] --> D');
  });

  it('keeps already quoted labels and does not double-escape', () => {
    const src = 'flowchart TD\nA["Diz #quot;oi#quot; (x)"] --> B{"Ok?"}';
    expect(repairMermaidSource(src).code).toBe(src);
  });

  it('handles nested parentheses in round and stadium shapes', () => {
    const r = repairMermaidSource('flowchart TD\nA(Calcula (x)) --> B([Fim (ok)]) --> C((Y (z)))');
    expect(r.code).toBe('flowchart TD\nA("Calcula (x)") --> B(["Fim (ok)"]) --> C(("Y (z)"))');
  });

  it('handles unusual shapes', () => {
    const r = repairMermaidSource(
      'flowchart TD\nA[(Banco: dados)] --> B[[Sub: rotina]] --> C{{Se: x}} --> D>Nota: y] --> E[/Entrada: z/]',
    );
    expect(r.code).toBe(
      'flowchart TD\nA[("Banco: dados")] --> B[["Sub: rotina"]] --> C{{"Se: x"}} --> D>"Nota: y"] --> E[/"Entrada: z"/]',
    );
  });

  it('survives an unbalanced bracket inside a label', () => {
    const r = repairMermaidSource('flowchart TD\nA[Texto (aberto] --> B');
    expect(r.code).toBe('flowchart TD\nA["Texto (aberto"] --> B');
  });

  it('repairs a label with stray inner quotes around it', () => {
    const r = repairMermaidSource('flowchart TD\nA["Diz "oi""] --> B');
    expect(r.code).toBe('flowchart TD\nA["Diz #quot;oi#quot;"] --> B');
  });

  it('keeps classes, styles, directions and comments untouched', () => {
    const src = [
      'flowchart TD',
      '%% comentário com (parênteses) e [1]',
      'A:::ok --> B',
      'classDef ok fill:#f9f,stroke:#333',
      'style B fill:#bbf',
      'linkStyle 0 stroke:red',
      'direction LR',
    ].join('\n');
    expect(repairMermaidSource(src).code).toBe(src);
  });

  it('does not rename or relabel when ids are unique after ASCII folding', () => {
    const r = repairMermaidSource('flowchart TD\nCalculo --> Cálculo');
    expect(r.code).toBe('flowchart TD\nCalculo --> Calculo_2["Cálculo"]');
  });

  it('does not touch a sequenceDiagram arrow or participant names', () => {
    const src = 'sequenceDiagram\n    Usuário->Sistema: oi\n    Sistema->>Usuário: ok';
    expect(repairMermaidSource(src).code).toBe(src);
  });

  it('does not double-convert existing #59; entities', () => {
    const src = 'sequenceDiagram\nA->>B: envia#59; valida';
    expect(repairMermaidSource(src).code).toBe(src);
  });

  it('leaves unknown diagram kinds with only character-level fixes', () => {
    const r = repairMermaidSource('zenuml\n“a”;');
    expect(r.kind).toBeNull();
    expect(r.code).toBe('zenuml\n"a";');
  });

  it('leaves gantt and mindmap bodies alone', () => {
    const gantt = 'gantt\n    title Plano\n    section A\n    Tarefa : a1, 2024-01-01, 30d';
    expect(repairMermaidSource(gantt).code).toBe(gantt);
    const mind = 'mindmap\n  root((Raiz))\n    Filho um\n    Filho dois';
    expect(repairMermaidSource(mind).code).toBe(mind);
  });
});

describe('fence handling', () => {
  it('relabels ```mmd, ~~~ fences and keeps the closing fence', () => {
    const r = normalizeDiagrams('~~~mmd\nflowchart TD\nA --> B\n~~~');
    expect(r.text).toBe('~~~mermaid\nflowchart TD\nA --> B\n~~~');
  });

  it('keeps a longer outer fence that contains a nested mermaid example', () => {
    const input = '````markdown\n```mermaid\nflowchart TD\nA -> B\n```\n````';
    expect(normalizeDiagrams(input).text).toBe(input);
  });

  it('infers a header for a ```mermaid block that has none', () => {
    const r = normalizeDiagrams('```mermaid\nA --> B\n```');
    expect(r.text).toBe('```mermaid\nflowchart TD\nA --> B\n```');
  });

  it('does not invent a header for a weak label with an implausible body', () => {
    const input = '```class\npublic class Foo {\n  int x;\n}\n```';
    expect(normalizeDiagrams(input).text).toBe(input);
    expect(normalizeDiagrams(input).diagrams).toHaveLength(0);
  });

  it('does not treat an ```sql block that mentions graph as a diagram', () => {
    const input = '```sql\nSELECT * FROM graph;\n```';
    expect(normalizeDiagrams(input).text).toBe(input);
  });

  it('indexes diagrams in document order and marks fenced ones', () => {
    const r = normalizeDiagrams(
      '```mermaid\nflowchart TD\nA --> B\n```\n\nsequenceDiagram\n  A->>B: oi\n',
    );
    expect(r.diagrams.map((d) => [d.index, d.fenced, d.kind])).toEqual([
      [0, true, 'flowchart'],
      [1, false, 'sequenceDiagram'],
    ]);
  });

  it('stops an unfenced block at a heading or a prose sentence', () => {
    const r = normalizeDiagrams(
      'flowchart TD\n  A --> B\n## Próxima seção\nflowchart LR\n  C --> D\nO fim é aqui.',
    );
    expect(r.diagrams).toHaveLength(2);
    expect(r.text).toContain('## Próxima seção');
    expect(r.text.endsWith('```\nO fim é aqui.')).toBe(true);
  });

  it('allows one blank line inside an unfenced block but not two', () => {
    const one = normalizeDiagrams('flowchart TD\n  A --> B\n\n  B --> C');
    expect(one.diagrams[0]?.code).toBe('flowchart TD\n  A --> B\n\n  B --> C');
    const two = normalizeDiagrams('flowchart TD\n  A --> B\n\n\n  B --> C');
    expect(two.diagrams[0]?.code).toBe('flowchart TD\n  A --> B');
  });

  it('returns the exact input when nothing changes', () => {
    const input = 'Olá\r\nSem diagramas.\n';
    expect(normalizeDiagrams(input).text).toBe(input);
  });
});

describe('hashDiagram', () => {
  it('is stable and whitespace-trim invariant', () => {
    expect(hashDiagram('flowchart TD\nA --> B')).toBe(hashDiagram('  \nflowchart TD\nA --> B\n\n'));
    expect(hashDiagram('flowchart TD\nA --> B')).toMatch(/^[0-9a-f]{8}$/);
    expect(hashDiagram('flowchart TD\nA --> B')).toBe(hashDiagram('flowchart TD\nA --> B'));
    expect(hashDiagram('a')).not.toBe(hashDiagram('b'));
  });

  it('matches the FNV-1a reference value', () => {
    expect(hashDiagram('')).toBe('811c9dc5');
    expect(hashDiagram('a')).toBe('e40c292c');
  });
});

describe('DIAGRAM_PROMPT_RULES', () => {
  it('states the Mermaid-only rules in pt-BR', () => {
    expect(DIAGRAM_PROMPT_RULES).toContain('```mermaid');
    expect(DIAGRAM_PROMPT_RULES).toContain('somente Mermaid');
    expect(DIAGRAM_PROMPT_RULES).toContain('ASCII-art');
    expect(DIAGRAM_PROMPT_RULES).toContain('`end`');
  });
});
