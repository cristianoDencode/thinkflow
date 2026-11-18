import { render, screen, waitFor } from '@testing-library/react';
import { hashDiagram } from '@thinkflow/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { DiagramContext } from './diagram-context';
import { Markdown } from './markdown';

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (code: string) => {
    if (code.includes('BROKEN')) throw new Error('Parse error on line 2');
    return true;
  }),
  render: vi.fn(async (_id: string, code: string) => ({
    svg: `<svg data-testid="mmd" data-code="${code.split('\n')[1] ?? ''}"></svg>`,
  })),
}));
vi.mock('mermaid', () => ({ default: mermaid }));

const FLOW = 'flowchart TD\nA["Início"] --> B';
const BROKEN = 'flowchart TD\nBROKEN --> B';

function view(
  content: string,
  opts: { streaming?: boolean; repairs?: Record<string, string | null> } = {},
) {
  return render(
    <ThemeProvider>
      <DiagramContext.Provider
        value={{ messageId: 'm1', model: 'groq/llama', repairs: opts.repairs }}
      >
        <Markdown content={content} streaming={opts.streaming ?? false} />
      </DiagramContext.Provider>
    </ThemeProvider>,
  );
}

describe('Markdown diagrams', () => {
  let posts: unknown[];
  beforeEach(() => {
    posts = [];
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        posts.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ code: 'flowchart TD\nFIXED --> B', repaired: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders an unfenced flowchart as an SVG', async () => {
    view('Segue:\nflowchart TD\nA[Início (x)] --> B\n');
    expect(await screen.findByTestId('mmd')).toBeInTheDocument();
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict' }),
    );
    expect(posts).toHaveLength(0);
  });

  it('shows the code while streaming without loading mermaid', () => {
    view(`\`\`\`mermaid\n${FLOW}\n\`\`\``, { streaming: true });
    expect(screen.getByTestId('mermaid-code')).toHaveTextContent('flowchart TD');
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('repairs a broken diagram with exactly one request', async () => {
    view(`\`\`\`mermaid\n${BROKEN}\n\`\`\``);
    expect(await screen.findByTestId('mmd')).toHaveAttribute('data-code', 'FIXED --> B');
    expect(posts).toEqual([
      expect.objectContaining({ code: BROKEN, model: 'groq/llama', messageId: 'm1' }),
    ]);
  });

  it('uses a stored repair without asking the server', async () => {
    view(`\`\`\`mermaid\n${BROKEN}\n\`\`\``, {
      repairs: { [hashDiagram(BROKEN)]: 'flowchart TD\nSTORED --> B' },
    });
    expect(await screen.findByTestId('mmd')).toHaveAttribute('data-code', 'STORED --> B');
    expect(posts).toHaveLength(0);
  });

  it('falls back to the code with a warning when the repair is known to fail', async () => {
    view(`\`\`\`mermaid\n${BROKEN}\n\`\`\``, { repairs: { [hashDiagram(BROKEN)]: null } });
    expect(await screen.findByText(/diagrama inválido/i)).toBeInTheDocument();
    expect(screen.getByTestId('mermaid-code')).toHaveTextContent('BROKEN');
    expect(posts).toHaveLength(0);
  });

  it('keeps ASCII art as plain code', async () => {
    view('```\n+-----+\n| A   |\n+-----+\n  |\n  v\n```');
    await waitFor(() => expect(document.querySelector('pre')).not.toBeNull());
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mmd')).toBeNull();
  });
});
