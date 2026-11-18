import { createContext, useContext } from 'react';

/** True while a page is rendered inside the route modal (its title is already in the modal header). */
export const InModalContext = createContext(false);

export function useInModal(): boolean {
  return useContext(InModalContext);
}
