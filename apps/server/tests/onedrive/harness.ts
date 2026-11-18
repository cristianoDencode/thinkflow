import { OneDriveService } from '../../src/contexts/onedrive/application/onedrive-service';
import { CHUNK_UNIT } from '../../src/contexts/onedrive/domain/constants';
import { HttpOneDriveGraph } from '../../src/contexts/onedrive/infrastructure/graph-client';
import { HttpMicrosoftOAuth } from '../../src/contexts/onedrive/infrastructure/microsoft-oauth';
import { SqliteOneDriveStore } from '../../src/contexts/onedrive/infrastructure/sqlite-onedrive-store';
import { SecretBox } from '../../src/shared/infrastructure/crypto';
import { onedriveAccount, onedriveAuthRequests } from '../../src/shared/infrastructure/db/schema';
import { openDatabase } from '../../src/shared/infrastructure/db/client';
import { FakeClock } from '../../src/shared/kernel/clock';
import { FakeMicrosoft, ME, TOKEN_URL, tokenResponse } from './fake-microsoft';

export const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
export const REDIRECT = 'http://localhost:3737/api/integrations/onedrive/callback';
export const GRAPH_ME = /graph\.microsoft\.com\/v1\.0\/me\?/;

export function setup(opts: { smallUploadLimit?: number; chunkSize?: number } = {}) {
  const handle = openDatabase(':memory:');
  const clock = new FakeClock();
  const fake = new FakeMicrosoft();
  const sleeps: number[] = [];
  const store = new SqliteOneDriveStore(handle.db, new SecretBox('test-secret'), clock);
  const service = new OneDriveService({
    store,
    oauth: new HttpMicrosoftOAuth(fake.fetch),
    graph: new HttpOneDriveGraph(fake.fetch),
    clock,
    sleep: async (ms) => void sleeps.push(ms),
    chunkSize: opts.chunkSize ?? CHUNK_UNIT * 2,
    ...(opts.smallUploadLimit !== undefined ? { smallUploadLimit: opts.smallUploadLimit } : {}),
  });
  fake.on('GET', GRAPH_ME, ME);
  fake.on('POST', TOKEN_URL, () => tokenResponse());
  return { handle, clock, fake, store, service, sleeps };
}

export type Ctx = ReturnType<typeof setup>;

/** Walks the whole authorization code flow against the fake. */
export async function connect(ctx: Ctx, secret?: string): Promise<void> {
  ctx.service.updateSettings({
    clientId: CLIENT_ID,
    ...(secret ? { clientSecret: secret } : {}),
  });
  const { authorizeUrl } = ctx.service.startAuthorization(REDIRECT);
  const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
  await ctx.service.completeAuthorization({ code: 'CODE-1', state });
}

/** What is on disk (ciphertext), serialized, to prove no secret is stored in clear. */
export function storedRows(ctx: Ctx) {
  return {
    account: JSON.stringify(ctx.handle.db.select().from(onedriveAccount).all()),
    authRequests: JSON.stringify(ctx.handle.db.select().from(onedriveAuthRequests).all()),
  };
}
