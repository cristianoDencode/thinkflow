import { LoaderCircle, Menu, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, type RouteObject } from 'react-router';
import { UNAUTHORIZED_EVENT } from '../../lib/api';
import { useAuthStatus, useHealth } from '../../lib/queries';
import { useTheme } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { AlertHost } from '../ui/alert-host';
import { Button } from '../ui/button';
import { AppContent, type ModalRoute } from './app-content';
import { Sidebar } from './sidebar';

const COLLAPSE_KEY = 'thinkflow-sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={resolved === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro'}
      title={resolved === 'dark' ? 'Tema claro' : 'Tema escuro'}
    >
      {resolved === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </Button>
  );
}

function StatusIndicator() {
  const { isError, isSuccess } = useHealth();
  const online = isSuccess && !isError;
  return (
    <span className="flex items-center gap-2 text-sm text-muted" role="status">
      <span
        className={cn('h-2.5 w-2.5 rounded-full', online ? 'bg-success' : 'bg-danger')}
        aria-hidden
      />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}

export function AppLayout({ routes, modals }: { routes: RouteObject[]; modals: ModalRoute[] }) {
  const { data, isLoading } = useAuthStatus();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => navigate('/login', { replace: true });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [navigate]);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, value ? '0' : '1');
      } catch {
        // ignore
      }
      return !value;
    });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="h-6 w-6 animate-spin text-accent-text" aria-label="Carregando" />
      </div>
    );
  }
  if (!data?.authenticated) return <Navigate to="/login" replace />;

  return (
    <div className="flex h-full overflow-hidden">
      <AlertHost />
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Abrir menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="ml-auto flex items-center gap-3">
            <StatusIndicator />
            <span className="h-6 w-px bg-border" aria-hidden />
            <ThemeToggle />
          </div>
        </header>
        <AppContent routes={routes} modals={modals} />
      </div>
    </div>
  );
}
