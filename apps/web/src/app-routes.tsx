import type { RouteObject } from 'react-router';
import type { ModalRoute } from './components/layout/app-content';
import { ChatPage } from './features/chat/chat-page';
import { ConnectionsPage } from './features/connections/connections-page';
import { DataPage } from './features/data-ai/data-page';
import { DatabasesPage } from './features/databases/databases-page';
import { HistoryPage } from './features/history/history-page';
import { LibraryDetailPage } from './features/library/library-detail-page';
import { LibraryPage } from './features/library/library-page';
import { McpPage } from './features/mcp/mcp-page';
import { ComingSoonPage, HelpPage } from './features/misc/pages';
import { PrototypeEditorPage } from './features/prototypes/prototype-editor-page';
import { PrototypesPage } from './features/prototypes/prototypes-page';
import { ReportDetailPage } from './features/reports/report-detail-page';
import { ReportsPage } from './features/reports/reports-page';
import { TemplateEditorPage } from './features/reports/template-editor-page';
import { SettingsPage } from './features/settings/settings-page';
import { TestSessionPage } from './features/tests/session-page';
import { TestsPage } from './features/tests/tests-page';
import { UsagePage } from './features/usage/usage-page';

/** Pages rendered in the main area (relative to the app layout, which is mounted on `/*`). */
export const pageRoutes: RouteObject[] = [
  { index: true, element: <ChatPage /> },
  { path: 'dados', element: <DataPage /> },
  { path: 'history', element: <HistoryPage /> },
  { path: 'usage', element: <UsagePage /> },
  { path: 'connections', element: <ConnectionsPage /> },
  { path: 'mcp', element: <McpPage /> },
  { path: 'databases', element: <DatabasesPage /> },
  { path: 'settings', element: <SettingsPage /> },
  { path: 'help', element: <HelpPage /> },
  { path: 'reports', element: <ReportsPage /> },
  { path: 'reports/templates/new', element: <TemplateEditorPage /> },
  { path: 'reports/templates/:id', element: <TemplateEditorPage /> },
  { path: 'reports/:id', element: <ReportDetailPage /> },
  { path: 'library', element: <LibraryPage /> },
  { path: 'library/:id', element: <LibraryDetailPage /> },
  { path: 'tests', element: <TestsPage /> },
  { path: 'tests/:id', element: <TestSessionPage /> },
  { path: 'prototypes', element: <PrototypesPage /> },
  { path: 'prototypes/:id', element: <PrototypeEditorPage /> },
  { path: '*', element: <ComingSoonPage title="Página não encontrada" /> },
];

/**
 * The user-menu pages. Opened from the menu they show as a modal over the current screen (the
 * page behind stays mounted); visited directly (deep link, reload) they render as full pages via
 * `pageRoutes` above.
 */
export const modalRoutes: ModalRoute[] = [
  { path: '/usage', title: 'Uso', element: <UsagePage /> },
  { path: '/connections', title: 'Conexões e roteamento', element: <ConnectionsPage /> },
  { path: '/mcp', title: 'MCP — fontes conectadas', element: <McpPage /> },
  { path: '/databases', title: 'Database — conexões Postgres', element: <DatabasesPage /> },
  { path: '/settings', title: 'Configurações', element: <SettingsPage /> },
  { path: '/help', title: 'Ajuda', element: <HelpPage /> },
];
