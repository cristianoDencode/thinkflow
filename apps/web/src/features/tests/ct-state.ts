import { useQuery } from '@tanstack/react-query';
import type { CtFieldsDto, CtStateDto, CtUseCaseEditDto } from '@thinkflow/shared';
import { api } from '../../lib/api';
import { keys } from '../../lib/queries';

export const ctBase = (sessionId: string) => `/api/tests/sessions/${sessionId}/ct`;

/** Under `keys.tests`, so every step/print change (which invalidates it) refreshes the CT too. */
export const ctKey = (sessionId: string) => [...keys.tests, 'ct', sessionId] as const;

export const useCtState = (sessionId: string) =>
  useQuery({
    queryKey: ctKey(sessionId),
    queryFn: () => api.get<CtStateDto>(ctBase(sessionId)),
  });

/** What the form edits: the fields and the title/status of each use case. */
export interface CtForm {
  fields: CtFieldsDto;
  useCases: CtUseCaseEditDto[];
}

export const toForm = (state: CtStateDto): CtForm => ({
  fields: state.fields,
  useCases: state.useCases,
});

export const formKey = (form: CtForm | null): string => JSON.stringify(form);

/** Body of `PUT .../ct`. */
export const toPayload = (form: CtForm) => ({
  ...form.fields,
  useCases: form.useCases.map(({ stepId, title, status }) => ({ stepId, title, status })),
});

const today = () =>
  new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(
    new Date(),
  );

/** "1.0" -> "1.1"; anything else is left for the person to type. */
export function nextVersion(last: string | undefined): string {
  const match = /^(.*?)(\d+)$/.exec(last?.trim() ?? '');
  return match ? `${match[1]}${Number(match[2]) + 1}` : '';
}

export function newVersionRow(fields: CtFieldsDto) {
  return {
    version: nextVersion(fields.versions.at(-1)?.version),
    date: today(),
    description: '',
    author: fields.author,
  };
}
