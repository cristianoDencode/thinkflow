#!/usr/bin/env node
/**
 * Fake `notebooklm` CLI for tests (no network, no Google). It mimics the flags and JSON shapes
 * recorded in the spike header of notebooklm-cli-gateway.ts, with invented ids and values.
 *
 * Test knobs are leading `--fake-*` arguments (the gateway's child env is minimal, so env vars
 * cannot carry them): put them in `cliCommand`, e.g. `node fake-notebooklm-cli.mjs --fake-log=/x.log`.
 *   --fake-log=FILE        append one JSON line per start/end (argv, env KEYS, auth marker, pid, times)
 *   --fake-login=ok|fail|sleep|nofile|invalid     behaviour of `login`
 *   --fake-refresh=ok|fail                        behaviour of `auth refresh`
 *   --fake-wait=ready|timeout|error               behaviour of `source wait`
 *   --fake-add=limit|limit-no-number              `source add` fails like a full notebook
 *   --fake-slow=MS                                 every command takes at least MS
 * Magic words in the question of `ask`: __TIMEOUT__ (hangs), __RATE__, __AUTH__, __GARBAGE__.
 * Auth: a credential whose first cookie value starts with "expired" behaves like an expired session.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const raw = process.argv.slice(2);
const fake = {};
while (raw[0]?.startsWith('--fake-')) {
  const [key, value = '1'] = raw.shift().slice(7).split('=');
  fake[key] = value;
}
let storage = null;
if (raw[0] === '--storage') {
  raw.shift();
  storage = raw.shift();
}

const envAuth = process.env.NOTEBOOKLM_AUTH_JSON;
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8);
const flag = (name) => {
  const i = raw.indexOf(name);
  return i >= 0 ? raw[i + 1] : undefined;
};
const flags = (name) => raw.flatMap((v, i) => (v === name ? [raw[i + 1]] : []));
const positionals = () => {
  const dd = raw.indexOf('--');
  if (dd >= 0) return raw.slice(dd + 1);
  const out = [];
  const withValue = new Set([
    '-n',
    '--type',
    '--title',
    '--mime-type',
    '--request-timeout',
    '--timeout',
    '--interval',
    '-s',
    '--prompt-file',
    '--storage',
    '--browser-timeout',
  ]);
  for (let i = 0; i < raw.length; i++) {
    if (withValue.has(raw[i])) i++;
    else if (!raw[i].startsWith('-')) out.push(raw[i]);
  }
  return out;
};

function parseAuth() {
  let text = envAuth;
  if (!text && storage && fs.existsSync(storage)) text = fs.readFileSync(storage, 'utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
const auth = parseAuth();
const marker = auth?.cookies?.[0]?.value ?? null;

const log = (entry) => {
  if (fake.log)
    fs.appendFileSync(
      fake.log,
      `${JSON.stringify({ pid: process.pid, at: Date.now(), ...entry })}\n`,
    );
};
log({
  event: 'start',
  argv: raw,
  storage: Boolean(storage),
  envKeys: Object.keys(process.env).sort(),
  home: process.env.NOTEBOOKLM_HOME ?? null,
  hasAuthEnv: Boolean(envAuth),
  marker,
  cwd: process.cwd(),
});
process.on('exit', () => log({ event: 'end' }));

const out = (value) => console.log(JSON.stringify(value));
const fail = (code, message, exit = 1) => {
  out({ error: true, code, message });
  process.exit(exit);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requireAuth = () => {
  if (!auth) fail('AUTH_REQUIRED', "Auth not found. Run 'notebooklm login' first.");
  if (String(marker).startsWith('expired'))
    fail(
      'UNEXPECTED_ERROR',
      'Unexpected error: Missing required cookies: __Secure-1PSIDTS. Run notebooklm login to re-authenticate.',
      2,
    );
};

const [cmd, sub] = raw;
if (fake.slow) await sleep(Number(fake.slow));

if (raw.includes('--version')) {
  console.log('NotebookLM CLI, version 0.0.0-fake');
} else if (cmd === 'login') {
  if (envAuth) {
    console.error("Error: Cannot run 'login' when NOTEBOOKLM_AUTH_JSON is set.");
    process.exit(1);
  }
  const file = flag('--storage') ?? storage;
  const mode = fake.login ?? 'ok';
  if (mode === 'sleep') {
    await sleep(60_000);
  } else if (mode === 'fail') {
    console.error('login failed');
    process.exit(1);
  } else if (mode === 'nofile') {
    process.exit(0);
  } else {
    fs.mkdirSync(path.join(path.dirname(file), 'browser_profile'), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(file), 'browser_profile', 'Cookies'),
      'fake-browser-cookies',
    );
    if (mode === 'invalid') fs.writeFileSync(file, 'not json', { mode: 0o600 });
    else
      fs.writeFileSync(
        file,
        JSON.stringify({
          cookies: [{ name: 'SID', value: 'fake-login-cookie', domain: '.google.com', path: '/' }],
          origins: [],
        }),
        { mode: 0o600 },
      );
  }
} else if (cmd === 'auth' && sub === 'check') {
  if (!auth) fail('AUTH_REQUIRED', "Auth not found. Run 'notebooklm login' first.");
  const expired = String(marker).startsWith('expired');
  out({
    status: expired ? 'error' : 'ok',
    account: { email: expired ? null : 'fake.user@example.com', authuser: 0 },
    checks: {
      storage_exists: true,
      json_valid: true,
      cookies_present: !expired,
      sid_cookie: true,
      token_fetch: expired ? false : raw.includes('--test') ? true : null,
    },
    details: {
      auth_source: envAuth ? 'NOTEBOOKLM_AUTH_JSON' : 'file',
      error: expired
        ? 'Token fetch failed: Missing required cookies: __Secure-1PSIDTS. Run login to re-authenticate.'
        : null,
      notebook_count: 0,
    },
    notebook_count: 0,
  });
  process.exit(expired ? 1 : 0);
} else if (cmd === 'auth' && sub === 'refresh') {
  if (envAuth) {
    console.error("Error: 'auth refresh' is incompatible with NOTEBOOKLM_AUTH_JSON.");
    process.exit(1);
  }
  if (fake.refresh === 'fail' || !auth) {
    console.error('Unexpected error: Missing required cookies: __Secure-1PSIDTS');
    process.exit(2);
  }
  auth.cookies[0].value = `fake-refreshed-${hash(String(Date.now()))}`;
  fs.writeFileSync(storage, JSON.stringify(auth), { mode: 0o600 });
  console.log('Refreshed');
} else if (cmd === 'create') {
  requireAuth();
  const title = positionals()[0] ?? '';
  out({
    notebook: { id: `nb_${hash(title)}`, title, role: 'owner', created_at: '2026-01-01T00:00:00' },
  });
} else if (cmd === 'delete') {
  requireAuth();
  out({ notebook_id: flag('-n'), success: true });
} else if (cmd === 'list') {
  requireAuth();
  out({ notebooks: [], count: 0 });
} else if (cmd === 'source' && sub === 'add') {
  requireAuth();
  const file = positionals().at(-1);
  if (!file || !fs.existsSync(file)) fail('VALIDATION_ERROR', 'File not found');
  if (fake.add === 'limit')
    fail('VALIDATION_ERROR', 'Notebook has reached the source limit (300 sources)');
  if (fake.add === 'limit-no-number') fail('VALIDATION_ERROR', 'Too many sources in this notebook');
  const title = flag('--title') ?? path.basename(file);
  log({
    event: 'source-add',
    title,
    mime: flag('--mime-type'),
    type: flag('--type'),
    size: fs.statSync(file).size,
    fileName: path.basename(file),
  });
  out({ source: { id: `src_${hash(`${flag('-n')}${title}`)}`, title, type: 'pdf', url: null } });
} else if (cmd === 'source' && sub === 'wait') {
  requireAuth();
  const id = raw[2];
  if (fake.wait === 'timeout') {
    out({ source_id: id, status: 'timeout' });
    process.exit(2);
  } else if (fake.wait === 'error') {
    out({ source_id: id, status: 'error', status_code: 3, error: 'processing failed' });
    process.exit(1);
  }
  out({ source_id: id, title: 'doc', status: 'ready', status_code: 2 });
} else if (cmd === 'source' && sub === 'delete') {
  requireAuth();
  out({
    action: 'delete',
    source_id: raw[2],
    notebook_id: flag('-n'),
    success: true,
    status: 'deleted',
  });
} else if (cmd === 'source' && sub === 'list') {
  requireAuth();
  out({ sources: [], count: 0 });
} else if (cmd === 'ask') {
  requireAuth();
  const promptFile = flag('--prompt-file');
  const question =
    promptFile && fs.existsSync(promptFile)
      ? fs.readFileSync(promptFile, 'utf8')
      : (positionals()[0] ?? '');
  log({
    event: 'ask',
    promptFileExisted: Boolean(promptFile && fs.existsSync(promptFile)),
    fresh: raw.includes('--new'),
    sources: flags('-s'),
    questionLength: question.length,
  });
  if (question.includes('__TIMEOUT__')) await sleep(60_000);
  if (question.includes('__RATE__'))
    fail('RATE_LIMITED', 'Rate limited by Google, retry after 60s');
  if (question.includes('__AUTH__')) fail('AUTH_ERROR', 'Authentication expired');
  if (question.includes('__GARBAGE__')) {
    console.log('this is not json');
    process.exit(0);
  }
  if (question.includes('__SLOW__')) await sleep(150);
  const sources = flags('-s');
  out({
    answer: `Resposta simulada [1].${sources.length ? ' [2]' : ''}`,
    conversation_id: 'conv_fake',
    turn_number: 1,
    is_follow_up: false,
    references: (sources.length ? sources : ['src_fake_1']).map((source_id, i) => ({
      source_id,
      citation_number: i + 1,
      cited_text: `Trecho citado ${i + 1}`,
      start_char: 0,
      end_char: 10,
    })),
  });
} else {
  console.error(`fake CLI: unsupported command ${raw.join(' ')}`);
  process.exit(64);
}
