import { useEffect } from 'react';
import { useLocation } from 'react-router';

/** Scrolls to the element named by the URL hash (`#step-…`) once the page has rendered it. */
export function useScrollToHash(ready = true): void {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash || !ready) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView?.({
        block: 'center',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, ready]);
}
