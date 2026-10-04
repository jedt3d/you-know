// You Know? — self-hosted Node server.
//
// Runs the exact Worker code (src/index.ts) on Node with the shims from
// shims.ts: SQLite for D1, in-process session objects for Durable Objects,
// real `ws` sockets for WebSockets, and dist/client served as static assets.
//
// Config (env): YK_PORT (8787), YK_HOST (0.0.0.0), YK_DB_PATH (./data/db.sqlite),
// YK_STATIC_DIR (dist/client next to this bundle).

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { openDb, makeD1, SessionNamespace } from './shims.ts';
import { normalizeCode } from '../src/ids.ts';

// @ts-ignore -- worker-typed module; identical runtime shape under the shims
import workerApp from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.YK_PORT ?? 8787);
const HOST = process.env.YK_HOST ?? '0.0.0.0';
const DB_PATH = process.env.YK_DB_PATH ?? resolve(here, '../../data/db.sqlite');
const STATIC_DIR = process.env.YK_STATIC_DIR ?? resolve(here, '../client');

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);
console.log(`[you-know] db at ${DB_PATH}`);

const sessions = new SessionNamespace(db);

// ---------------------------------------------------------- static assets

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function serveAsset(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let p = decodeURIComponent(url.pathname);
  if (p.includes('..') || p.includes('\0')) return Promise.resolve(new Response('bad request', { status: 400 }));
  let file = normalize(join(STATIC_DIR, p));
  if (!file.startsWith(STATIC_DIR)) return Promise.resolve(new Response('forbidden', { status: 403 }));
  if (url.pathname === '/' || !existsSync(file)) file = join(STATIC_DIR, 'index.html'); // SPA fallback
  if (!existsSync(file)) return Promise.resolve(new Response('not found', { status: 404 }));
  const ext = file.slice(file.lastIndexOf('.'));
  const immutable = url.pathname.startsWith('/assets/');
  return Promise.resolve(
    new Response(new Uint8Array(readFileSync(file)), {
      headers: {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    }),
  );
}

const env = {
  DB: makeD1(db),
  SESSION: sessions,
  ASSETS: { fetch: (req: Request) => serveAsset(req) },
};

// ------------------------------------------------------------- http + ws

interface NodeInfo {
  incoming?: { socket?: { remoteAddress?: string } };
}

const server = serve({
  // @ts-ignore -- the adapter passes HttpBindings as 2nd arg
  fetch: (req: Request, info?: NodeInfo) =>
    workerApp.fetch(req, { ...env, remoteIp: info?.incoming?.socket?.remoteAddress ?? undefined }),
  hostname: HOST,
  port: PORT,
});
console.log(`[you-know] listening on http://${HOST}:${PORT} (static: ${STATIC_DIR})`);

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]+)/);
  if (!m) {
    socket.destroy();
    return;
  }
  const code = normalizeCode(m[1]);
  // Authenticate inside the DO *before* completing the handshake, so a
  // rejected token gets a real HTTP error instead of a dropped socket.
  // Namespace keys are "s:" + code (see stubFor in src/index.ts).
  void sessions
    .upgrade('s:' + code, url)
    .then(({ status, client }) => {
      if (!client) {
        socket.write(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        client.setOnmessage((d) => ws.send(d));
        client._onclose = () => {
          try {
            ws.close();
          } catch {
            // already closed
          }
        };
        ws.on('message', (data, isBinary) => {
          if (!isBinary) client.send(data.toString());
        });
        ws.on('close', () => client.close());
        ws.on('error', () => client.close());
      });
    })
    .catch((e) => {
      console.error('[you-know] ws upgrade failed', e);
      socket.destroy();
    });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[you-know] ${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
