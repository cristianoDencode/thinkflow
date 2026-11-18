import type { CtLayout } from '@thinkflow/shared';
import { CT_FIRST_VERSION, CT_FIRST_VERSION_DESCRIPTION, type CtDocument } from './ct-document';

/** A named look for the CT document ("modelo"). The built-in "Padrão" is not stored. */
export interface CtModel {
  id: string;
  name: string;
  layout: CtLayout;
  createdAt: number;
  updatedAt: number;
}

export interface CtModelRepository {
  /** Oldest first. */
  list(): Promise<CtModel[]>;
  find(id: string): Promise<CtModel | null>;
  save(model: CtModel): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Small made-up document the model editor previews (no screenshots, nothing of the user's). */
export const CT_SAMPLE_DOCUMENT: CtDocument = {
  title: 'Exemplo de documento',
  ticketId: '12345',
  priority: 'Normal',
  systemModule: 'Módulo de exemplo',
  author: 'Nome do Responsável',
  analysisTitle: 'Análise',
  context: 'Texto de contexto do caso de teste, que descreve o cenário e o objetivo da validação.',
  useCases: [
    {
      status: 'Finalizado',
      items: [
        { kind: 'text', text: 'Acessar a tela e informar os dados do cenário.' },
        { kind: 'text', text: 'Conferir se o resultado exibido é o esperado.' },
      ],
    },
    {
      title: 'Cenário alternativo',
      status: 'Pendente',
      items: [{ kind: 'text', text: 'Passos do cenário.' }],
    },
  ],
  versions: [
    {
      version: CT_FIRST_VERSION,
      date: '01/01/2026',
      description: CT_FIRST_VERSION_DESCRIPTION,
      author: 'Nome do Responsável',
    },
  ],
};
