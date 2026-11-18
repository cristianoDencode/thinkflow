import { useCallback, useMemo, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import {
  UNSAFE_LocationContext as LocationContext,
  useLocation,
  useNavigate,
  useNavigationType,
  useRoutes,
  type Location,
  type RouteObject,
} from 'react-router';
import { readBackground, samePath } from '../../lib/background-location';
import { Dialog } from '../ui/dialog';
import { InModalContext } from '../ui/modal-context';

/** A page that opens in a modal over the current screen when navigated to with a background location. */
export interface ModalRoute {
  /** Absolute path, e.g. `/connections`. */
  path: string;
  /** Modal header title (replaces the page's own heading). */
  title: string;
  element: ReactNode;
}

const toPath = (url: Pick<Location, 'pathname' | 'search' | 'hash'>) =>
  `${url.pathname}${url.search}${url.hash}`;

/**
 * Renders the app area. The main routes are rendered with `useRoutes` against the "effective"
 * location: the background location while a modal route is open, the real one otherwise. The
 * element tree is identical in both cases, so the background page is never unmounted nor
 * remounted when a modal opens or closes (a streaming chat answer keeps running).
 *
 * The background subtree also sees the background as its router location (`useLocation`,
 * `useSearchParams`), otherwise e.g. the chat would lose its `?c=` conversation.
 */
export function AppContent({ routes, modals }: { routes: RouteObject[]; modals: ModalRoute[] }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const background = readBackground(location);
  const modal = background
    ? modals.find((candidate) => samePath(candidate.path, location.pathname))
    : undefined;
  const mainLocation = modal && background ? background : location;

  const main = useRoutes(routes, mainLocation);
  const locationValue = useMemo(
    () => ({ location: mainLocation, navigationType }),
    [mainLocation, navigationType],
  );

  return (
    <>
      <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <LocationContext.Provider value={locationValue}>{main}</LocationContext.Provider>
      </main>
      {modal && background && (
        <RouteModal
          key={modal.path}
          modal={modal}
          modals={modals}
          location={location}
          background={background}
        />
      )}
    </>
  );
}

function RouteModal({
  modal,
  modals,
  location,
  background,
}: {
  modal: ModalRoute;
  modals: ModalRoute[];
  location: Location;
  background: Location;
}) {
  const navigate = useNavigate();
  const navigationType = useNavigationType();

  const close = useCallback(() => {
    // opened in-app (PUSH): going back lands exactly on the background entry.
    // Reload / deep history entry: replace this entry with the background instead.
    if (navigationType === 'PUSH') navigate(-1);
    else navigate(toPath(background), { replace: true, state: background.state });
  }, [navigate, navigationType, background]);

  // Links inside the modal: same modal family stays in the modal, anything else closes it.
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download'))
      return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    const target = toPath(url);
    if (modals.some((candidate) => samePath(candidate.path, url.pathname)))
      navigate(target, { replace: true, state: location.state });
    else navigate(target, { replace: true });
  };

  return (
    <Dialog open onClose={close} title={modal.title} size="xl">
      <div onClickCapture={onClickCapture}>
        <InModalContext.Provider value>{modal.element}</InModalContext.Provider>
      </div>
    </Dialog>
  );
}
