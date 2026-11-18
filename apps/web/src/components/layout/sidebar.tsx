import { useQueryClient } from '@tanstack/react-query';
import {
  ChartColumn,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Database,
  DatabaseZap,
  FlaskConical,
  Gauge,
  History,
  LayoutTemplate,
  Library,
  LogOut,
  MessageSquareText,
  Puzzle,
  Route,
  Settings,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, matchPath, NavLink, useLocation, useNavigate } from 'react-router';
import { modalState, readBackground, samePath } from '../../lib/background-location';
import { api } from '../../lib/api';
import { useAuthStatus } from '../../lib/queries';
import { cn, initials } from '../../lib/utils';
import { Button } from '../ui/button';
import { Logo } from './logo';

interface NavItem {
  to: string;
  label: string;
  subtitle?: string;
  icon: LucideIcon;
  soon?: boolean;
}

const PRIMARY: NavItem[] = [
  { to: '/', label: 'Pergunte à AI', icon: MessageSquareText },
  { to: '/dados', label: 'Dados com IA', icon: DatabaseZap },
  { to: '/history', label: 'Histórico', icon: History },
  { to: '/library', label: 'Biblioteca', icon: Library },
  { to: '/reports', label: 'Relatórios', icon: ChartColumn },
  { to: '/tests', label: 'Testes', icon: FlaskConical },
  { to: '/prototypes', label: 'Protótipos', icon: LayoutTemplate },
];

/** Items of the user dropdown, shown above "Sair". */
const FOOTER: NavItem[] = [
  { to: '/usage', label: 'Uso', icon: Gauge },
  { to: '/connections', label: 'Conexões', icon: Route },
  { to: '/mcp', label: 'MCP', icon: Puzzle },
  { to: '/databases', label: 'Database', icon: Database },
  { to: '/settings', label: 'Configurações', icon: Settings },
  { to: '/help', label: 'Ajuda', icon: CircleHelp },
];

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onCloseMobile,
}: {
  collapsed: boolean;
  onToggleCollapsed(): void;
  mobileOpen: boolean;
  onCloseMobile(): void;
}) {
  const { data: auth } = useAuthStatus();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const user = auth?.user;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const logout = async () => {
    await api.post('/api/auth/logout');
    queryClient.clear();
    navigate('/login');
  };

  // while a menu page is open as a modal, the page behind it is the one that counts as current
  const currentPath = readBackground(location)?.pathname ?? location.pathname;

  const item = (entry: NavItem) => {
    const isActive = matchPath({ path: entry.to, end: entry.to === '/' }, currentPath) !== null;
    return (
      <Link
        key={entry.to}
        to={entry.to}
        onClick={onCloseMobile}
        title={collapsed ? entry.label : undefined}
        className={cn(
          'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors',
          isActive ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-surface-hover hover:text-fg',
          collapsed && 'justify-center px-0',
        )}
        aria-current={isActive ? 'page' : undefined}
      >
        {isActive && (
          <span
            className="absolute top-2 bottom-2 -left-3 w-1 rounded-r-full bg-accent"
            aria-hidden
          />
        )}
        <entry.icon
          className={cn('h-5 w-5 shrink-0', isActive && 'text-accent-text')}
          aria-hidden
        />
        {!collapsed && (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">{entry.label}</span>
            {entry.subtitle && (
              <span className="truncate text-[11px] text-subtle">{entry.subtitle}</span>
            )}
          </span>
        )}
        {!collapsed && entry.soon && (
          <span className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
            Em breve
          </span>
        )}
      </Link>
    );
  };

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={onCloseMobile}
          aria-hidden
        />
      )}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-sidebar transition-all duration-200 lg:static lg:translate-x-0',
          collapsed ? 'lg:w-20' : 'lg:w-72',
          'w-72',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Navegação principal"
      >
        <div
          className={cn(
            'flex h-20 items-center justify-between px-5',
            collapsed && 'lg:justify-center lg:px-0',
          )}
        >
          <div className={cn(collapsed && 'lg:hidden')}>
            <Logo />
          </div>
          <Button
            variant="secondary"
            size="icon-sm"
            className="hidden lg:inline-flex"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            onClick={onCloseMobile}
            aria-label="Fechar menu"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <nav className="scrollbar-thin flex flex-1 flex-col gap-1 overflow-y-auto px-3 pt-2">
          {PRIMARY.map(item)}
        </nav>

        <div className="border-t border-border p-3">
          <div className="relative" ref={menuRef}>
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-3 rounded-xl p-2 text-left hover:bg-surface-hover',
                collapsed && 'justify-center',
              )}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Menu do usuário"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg">
                {initials(user?.name ?? '')}
              </span>
              {!collapsed && (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{user?.name ?? '—'}</span>
                    <span className="block truncate text-xs text-muted">
                      {user?.title || 'Thinkflow'}
                    </span>
                  </span>
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 text-muted transition-transform',
                      menuOpen && 'rotate-180',
                    )}
                  />
                </>
              )}
            </button>
            {menuOpen && (
              <div
                role="menu"
                aria-label="Menu do usuário"
                className="absolute bottom-full left-0 mb-2 w-full min-w-56 rounded-xl border border-border bg-bg-elevated p-1 shadow-xl"
              >
                {FOOTER.map((entry) => (
                  <NavLink
                    key={entry.to}
                    to={entry.to}
                    // opens over the current screen so whatever is running behind it keeps running
                    state={samePath(entry.to, location.pathname) ? undefined : modalState(location)}
                    role="menuitem"
                    onClick={() => {
                      // the modal returns focus to whatever was focused when it opened
                      menuButtonRef.current?.focus();
                      setMenuOpen(false);
                      onCloseMobile();
                    }}
                    className={({ isActive }) =>
                      cn(
                        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                        isActive
                          ? 'bg-accent-soft text-fg'
                          : 'text-muted hover:bg-surface-hover hover:text-fg',
                      )
                    }
                  >
                    <entry.icon className="h-4 w-4" aria-hidden /> {entry.label}
                  </NavLink>
                ))}
                <div className="mx-2 my-1 border-t border-border" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={logout}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-hover hover:text-fg"
                >
                  <LogOut className="h-4 w-4" /> Sair
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
