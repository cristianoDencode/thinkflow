import { createContext, useContext } from 'react';

/** What a diagram needs to ask the server for a repair and to reuse earlier ones. */
export interface DiagramContextValue {
  messageId?: string;
  model?: string;
  /** hashDiagram(code) -> repaired code, or null when a repair already failed. */
  repairs?: Record<string, string | null>;
}

export const DiagramContext = createContext<DiagramContextValue>({});

export function useDiagramContext(): DiagramContextValue {
  return useContext(DiagramContext);
}
