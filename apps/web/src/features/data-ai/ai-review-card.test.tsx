import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiReviewDto } from '@thinkflow/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiReviewCard } from './ai-review-card';

const review: AiReviewDto = {
  reviewId: 'rev-1',
  databaseId: 'db-1',
  sql: 'select situacao, upper(obs) from cgm',
  columns: [
    {
      index: 1,
      name: 'situacao',
      type: 'text',
      source: { schema: 'public', table: 'cgm', column: 'situacao' },
      proposed: 'tokenize',
      kind: null,
      sample: ['aberto', 'Maria da Silva'],
    },
    {
      index: 2,
      name: 'upper',
      type: 'text',
      source: null,
      proposed: 'tokenize',
      kind: null,
      sample: ['OBS'],
    },
  ],
};

let posts: { url: string; body: Record<string, unknown> }[];
let failWith: number | null;

beforeEach(() => {
  posts = [];
  failWith = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (failWith)
        return new Response(JSON.stringify({ error: { message: 'Revisão não encontrada' } }), {
          status: failWith,
        });
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const group = (name: string) => screen.getByRole('radiogroup', { name: `Para a IA: ${name}` });

describe('AiReviewCard', () => {
  it('shows the real sample values, the source and the proposed action preselected', () => {
    render(<AiReviewCard review={review} />);
    expect(screen.getByRole('region', { name: 'Revisar o que vai para a IA' })).toBeInTheDocument();
    expect(screen.getByText('aberto')).toBeInTheDocument();
    expect(screen.getByText('Maria da Silva')).toBeInTheDocument();
    expect(screen.getByText('public.cgm.situacao · text')).toBeInTheDocument();
    expect(screen.getByText('expressão · text')).toBeInTheDocument();
    for (const name of ['situacao', 'upper']) {
      expect(within(group(name)).getByRole('radio', { name: 'Tokenizar' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    }
    // remember is on by default, but disabled for expressions
    expect(screen.getByLabelText('Lembrar para esta coluna: situacao')).toBeChecked();
    expect(screen.getByLabelText('Lembrar para esta coluna: upper')).toBeDisabled();
    expect(screen.getByLabelText('Lembrar para esta coluna: upper')).not.toBeChecked();
  });

  it('sends the chosen actions and remember flags, then collapses to a summary', async () => {
    const user = userEvent.setup();
    render(<AiReviewCard review={review} />);
    await user.click(within(group('situacao')).getByRole('radio', { name: 'Liberar' }));
    await user.click(within(group('upper')).getByRole('radio', { name: 'Omitir' }));
    await user.click(screen.getByLabelText('Lembrar para esta coluna: situacao'));
    await user.click(screen.getByRole('button', { name: /Enviar à IA/ }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/api/chat/reviews/rev-1',
      body: {
        decisions: [
          { index: 1, action: 'reveal', remember: false },
          // expressions are never remembered, even if the state said so
          { index: 2, action: 'omit', remember: false },
        ],
      },
    });
    const summary = await screen.findByRole('region', { name: 'Revisão de privacidade concluída' });
    expect(within(summary).getByText('Revisão enviada.')).toBeInTheDocument();
    expect(within(summary).getByText('situacao: Liberar')).toBeInTheDocument();
    expect(within(summary).getByText('upper: Omitir')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enviar à IA/ })).toBeNull();
  });

  it('"Tokenizar tudo" tokenizes every column in one click', async () => {
    const user = userEvent.setup();
    render(<AiReviewCard review={review} />);
    await user.click(within(group('situacao')).getByRole('radio', { name: 'Liberar' }));
    await user.click(screen.getByRole('button', { name: 'Tokenizar tudo' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0]!.body.decisions as { action: string }[]).map((d) => d.action)).toEqual([
      'tokenize',
      'tokenize',
    ]);
  });

  it('keeps the card open with the error when the review is gone', async () => {
    failWith = 404;
    const user = userEvent.setup();
    render(<AiReviewCard review={review} />);
    await user.click(screen.getByRole('button', { name: /Enviar à IA/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Revisão não encontrada');
    expect(screen.getByRole('button', { name: /Enviar à IA/ })).toBeEnabled();
  });

  it('shows the safe default when the server closed it (timeout / abort)', () => {
    const { rerender } = render(<AiReviewCard review={review} closed="timeout" />);
    expect(screen.getByText(/Tempo esgotado/)).toBeInTheDocument();
    expect(screen.getByText('situacao: Tokenizar')).toBeInTheDocument();
    rerender(<AiReviewCard review={review} closed="aborted" />);
    expect(screen.getByText(/Interrompida/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enviar à IA/ })).toBeNull();
  });
});
