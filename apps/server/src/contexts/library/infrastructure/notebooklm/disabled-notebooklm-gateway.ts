import { NotebookLmError, type NotebookLmGateway } from '../../domain/ports';

const notConfigured = (): never => {
  throw new NotebookLmError('not_configured', 'NotebookLM não configurado');
};

/** Null object: every operation reports that NotebookLM is not configured. */
export class DisabledNotebookLmGateway implements NotebookLmGateway {
  check(): Promise<{ ok: boolean; message: string }> {
    return Promise.resolve({ ok: false, message: 'NotebookLM não configurado' });
  }
  refreshCredentials(): Promise<void> {
    return Promise.resolve().then(notConfigured);
  }
  createNotebook(): Promise<{ id: string }> {
    return Promise.resolve().then(notConfigured);
  }
  deleteNotebook(): Promise<void> {
    return Promise.resolve().then(notConfigured);
  }
  addSource(): Promise<{ sourceId: string }> {
    return Promise.resolve().then(notConfigured);
  }
  waitSourceReady(): Promise<void> {
    return Promise.resolve().then(notConfigured);
  }
  deleteSource(): Promise<void> {
    return Promise.resolve().then(notConfigured);
  }
  ask(): Promise<{
    answer: string;
    references: { sourceId: string; citationNumber: number; citedText: string }[];
  }> {
    return Promise.resolve().then(notConfigured);
  }
}
