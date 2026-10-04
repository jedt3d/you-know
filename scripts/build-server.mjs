// Bundle the self-hosted Node server → dist/server/server.mjs.
// better-sqlite3 is native and stays external (installed on the target).

import { build } from 'esbuild';

await build({
  entryPoints: ['server/node.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  outfile: 'dist/server/server.mjs',
  external: ['better-sqlite3'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'info',
});

console.log('built dist/server/server.mjs');
