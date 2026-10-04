// Build the client SPA with esbuild directly.
//
// Why not vite? The project directory contains a "?" (YouKnow?), which
// vite/rolldown treat as a URL query separator when resolving entries.
// esbuild handles paths as plain strings, so it works. Output shape matches
// what wrangler's assets binding expects: dist/client/index.html + assets.

import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Build identity shown in the app footer: package version, the git commit
// being built (short id), and the build timestamp.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  // not a git checkout (e.g. extracted tarball)
}
const buildTime = new Date().toISOString();

const outDir = 'dist/client';
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir + '/assets', { recursive: true });

await build({
  entryPoints: ['client/main.tsx'],
  bundle: true,
  format: 'esm',
  minify: true,
  outfile: outDir + '/assets/app.js',
  loader: { '.ts': 'ts', '.tsx': 'tsx', '.css': 'css', '.woff2': 'file', '.woff': 'file' },
  assetNames: '[name]-[hash]',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
});

const jsHash = createHash('sha256').update(readFileSync(outDir + '/assets/app.js')).digest('hex').slice(0, 10);
cpSync(outDir + '/assets/app.js', outDir + `/assets/app.${jsHash}.js`);

let cssTag = '';
try {
  // woff2 is universal on supported browsers; drop the legacy .woff
  // fallbacks from the font-face src lists and delete their files.
  const css = readFileSync(outDir + '/assets/app.css', 'utf8').replace(
    /,?\s*url\([^)]*\.woff\)\s*format\('woff'\)/g,
    '',
  );
  writeFileSync(outDir + '/assets/app.css', css);
  const cssHash = createHash('sha256').update(css).digest('hex').slice(0, 10);
  cpSync(outDir + '/assets/app.css', outDir + `/assets/app.${cssHash}.css`);
  cssTag = `<link rel="stylesheet" href="/assets/app.${cssHash}.css" />`;
  for (const f of readdirSync(outDir + '/assets')) {
    if (f.endsWith('.woff')) rmSync(outDir + '/assets/' + f);
  }
} catch {
  // no css produced — shouldn't happen
}

const html = readFileSync('index.html', 'utf8').replace(
  '</head>',
  `${cssTag}<script type="module" src="/assets/app.${jsHash}.js"></script></head>`,
);
writeFileSync(outDir + '/index.html', html);

// The dev-time entry (index.html references /client/main.tsx) is not shipped.
rmSync(outDir + '/assets/app.js', { force: true });
rmSync(outDir + '/assets/app.css', { force: true });
console.log(`built ${outDir} (app.${jsHash}.js)`);
