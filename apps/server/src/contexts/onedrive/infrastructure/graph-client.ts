import { OneDriveError } from '../domain/errors';
import type {
  ChunkResult,
  DriveItem,
  FetchFn,
  OneDriveAccountInfo,
  OneDriveGraph,
} from '../domain/ports';

export const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const ITEM_SELECT = '$select=id,name,webUrl,folder,file,parentReference';

interface GraphItem {
  id?: unknown;
  name?: unknown;
  webUrl?: unknown;
  folder?: { childCount?: unknown } | null;
  parentReference?: { id?: unknown; path?: unknown } | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** `/drive/root:/A/B` or `/drives/{id}/root:/A/B` -> `/A/B` (root -> `/`). */
function stripRootPrefix(path: string): string {
  const stripped = path.replace(/^\/drives?(?:\/[^/]+)?\/root:?/, '');
  return stripped === '' ? '/' : stripped;
}

export function toDriveItem(raw: GraphItem): DriveItem {
  const parent = raw.parentReference;
  return {
    id: str(raw.id),
    name: str(raw.name),
    webUrl: str(raw.webUrl),
    isFolder: !!raw.folder,
    childCount: typeof raw.folder?.childCount === 'number' ? raw.folder.childCount : null,
    parentId: parent && typeof parent.id === 'string' ? parent.id : null,
    parentPath: parent && typeof parent.path === 'string' ? stripRootPrefix(parent.path) : null,
  };
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

async function graphCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === 'string' ? body.error.code : '';
  } catch {
    return '';
  }
}

/** Maps a failed Graph response to a pt-BR error (never echoes tokens, URLs or Graph's own text). */
export async function mapGraphError(response: Response): Promise<OneDriveError> {
  const status = response.status;
  const code = await graphCode(response);
  if (status === 401) {
    return new OneDriveError('unauthorized', 'O OneDrive recusou o token de acesso.');
  }
  if (status === 403) {
    return new OneDriveError(
      'forbidden',
      'Sem permissão no OneDrive para esta operação. Reconecte e aceite o acesso aos arquivos.',
    );
  }
  if (status === 404) {
    return new OneDriveError('not_found', 'Pasta ou arquivo não encontrado no OneDrive.');
  }
  if (status === 409 || status === 412) {
    return new OneDriveError(
      'conflict',
      'Já existe um arquivo com esse nome na pasta do OneDrive.',
    );
  }
  if (status === 429) {
    const retryAfterSec = retryAfterSeconds(response);
    return new OneDriveError(
      'rate_limited',
      retryAfterSec !== undefined
        ? `O OneDrive limitou as requisições. Tente de novo em ${retryAfterSec} s.`
        : 'O OneDrive limitou as requisições. Tente de novo em instantes.',
      retryAfterSec !== undefined ? { retryAfterSec } : {},
    );
  }
  if (status === 507) {
    return new OneDriveError('quota', 'O OneDrive está sem espaço livre.');
  }
  if (status >= 500) {
    const retryAfterSec = retryAfterSeconds(response);
    return new OneDriveError(
      'upstream',
      'O OneDrive está indisponível no momento. Tente de novo em instantes.',
      retryAfterSec !== undefined ? { retryAfterSec } : {},
    );
  }
  return new OneDriveError('bad_request', `O OneDrive recusou a requisição (${code || status}).`);
}

function driveBase(parentId: string): string {
  return parentId === 'root'
    ? `${GRAPH_ROOT}/me/drive/root`
    : `${GRAPH_ROOT}/me/drive/items/${encodeURIComponent(parentId)}`;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: 'application/json' };
}

export class HttpOneDriveGraph implements OneDriveGraph {
  constructor(private readonly fetchFn: FetchFn) {}

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, init);
    } catch {
      throw new OneDriveError('upstream', 'Não foi possível falar com o OneDrive.');
    }
  }

  private async json<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.send(url, init);
    if (!response.ok) throw await mapGraphError(response);
    return (await response.json()) as T;
  }

  async me(token: string): Promise<OneDriveAccountInfo> {
    const me = await this.json<{
      id?: unknown;
      displayName?: unknown;
      mail?: unknown;
      userPrincipalName?: unknown;
    }>(`${GRAPH_ROOT}/me?$select=id,displayName,mail,userPrincipalName`, {
      headers: bearer(token),
    });
    const email = str(me.mail) || str(me.userPrincipalName);
    return { id: str(me.id), name: str(me.displayName) || email, email };
  }

  async getItem(token: string, ref: { id: string } | { path: string }): Promise<DriveItem> {
    let base: string;
    if ('id' in ref) {
      base = driveBase(ref.id);
    } else {
      const segments = ref.path.split('/').filter((s) => s !== '');
      base =
        segments.length === 0
          ? `${GRAPH_ROOT}/me/drive/root`
          : `${GRAPH_ROOT}/me/drive/root:/${segments.map(encodeURIComponent).join('/')}`;
    }
    return toDriveItem(
      await this.json<GraphItem>(`${base}?${ITEM_SELECT}`, { headers: bearer(token) }),
    );
  }

  async listChildren(token: string, parentId: string): Promise<DriveItem[]> {
    const items: DriveItem[] = [];
    let url: string | null = `${driveBase(parentId)}/children?${ITEM_SELECT}&$top=200`;
    // a few pages are plenty for a folder picker; stops runaway paging
    for (let page = 0; url && page < 10; page++) {
      const body: { value?: GraphItem[]; '@odata.nextLink'?: unknown } = await this.json(url, {
        headers: bearer(token),
      });
      for (const raw of body.value ?? []) items.push(toDriveItem(raw));
      const next: unknown = body['@odata.nextLink'];
      // only follow links that stay on Graph
      url = typeof next === 'string' && next.startsWith(`${GRAPH_ROOT}/`) ? next : null;
    }
    return items;
  }

  async putSmall(
    token: string,
    parentId: string,
    name: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<DriveItem> {
    const url = `${driveBase(parentId)}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`;
    return toDriveItem(
      await this.json<GraphItem>(url, {
        method: 'PUT',
        headers: { ...bearer(token), 'content-type': contentType },
        body: bytes as unknown as NonNullable<RequestInit['body']>,
      }),
    );
  }

  async createUploadSession(
    token: string,
    parentId: string,
    name: string,
  ): Promise<{ uploadUrl: string }> {
    const url = `${driveBase(parentId)}:/${encodeURIComponent(name)}:/createUploadSession`;
    const body = await this.json<{ uploadUrl?: unknown }>(url, {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail', name } }),
    });
    if (typeof body.uploadUrl !== 'string' || body.uploadUrl === '') {
      throw new OneDriveError('upstream', 'O OneDrive não devolveu a URL de envio.');
    }
    return { uploadUrl: body.uploadUrl };
  }

  async putChunk(
    uploadUrl: string,
    chunk: Uint8Array,
    start: number,
    total: number,
  ): Promise<ChunkResult> {
    const end = start + chunk.byteLength - 1;
    // pre-authenticated URL: sending the bearer token here makes Microsoft answer 401
    const response = await this.send(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-range': `bytes ${start}-${end}/${total}`,
      },
      body: chunk as unknown as NonNullable<RequestInit['body']>,
    });
    if (response.status === 416) {
      // that range was already received: continue from what the service is waiting for
      return { done: false, next: await this.uploadStatus(uploadUrl) };
    }
    if (!response.ok) throw await mapGraphError(response);
    if (response.status === 202) {
      const body = (await response.json().catch(() => ({}))) as { nextExpectedRanges?: unknown };
      return { done: false, next: firstExpected(body.nextExpectedRanges) ?? end + 1 };
    }
    return { done: true, item: toDriveItem((await response.json()) as GraphItem) };
  }

  async uploadStatus(uploadUrl: string): Promise<number> {
    const body = await this.json<{ nextExpectedRanges?: unknown }>(uploadUrl, {
      headers: { accept: 'application/json' },
    });
    return firstExpected(body.nextExpectedRanges) ?? 0;
  }

  async cancelUploadSession(uploadUrl: string): Promise<void> {
    await this.send(uploadUrl, { method: 'DELETE' }).catch(() => undefined);
  }

  async downloadPdf(token: string, itemId: string): Promise<Uint8Array> {
    // Graph answers 302 to a pre-authenticated URL; fetch follows it (and drops the bearer token)
    const response = await this.send(
      `${GRAPH_ROOT}/me/drive/items/${encodeURIComponent(itemId)}/content?format=pdf`,
      { headers: { authorization: `Bearer ${token}` }, redirect: 'follow' },
    );
    if (!response.ok) throw await mapGraphError(response);
    return new Uint8Array(await response.arrayBuffer());
  }
}

function firstExpected(ranges: unknown): number | undefined {
  if (!Array.isArray(ranges) || typeof ranges[0] !== 'string') return undefined;
  const n = Number.parseInt(ranges[0].split('-')[0] ?? '', 10);
  return Number.isNaN(n) ? undefined : n;
}
