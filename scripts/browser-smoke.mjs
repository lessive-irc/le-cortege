#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--help')) {
  console.log(`Usage: node scripts/browser-smoke.mjs [options]

Options:
  --page PATH       HTML page to check (default: index.html)
  --browser PATH    Chromium executable (default: chromium; CHROMIUM overrides)
  --width N         Screenshot width (default: 400)
  --height N        Screenshot height (default: 800)
  --seconds N       Virtual browser time (default: 4, minimum: 2)
  --out PATH        Screenshot path (default: /tmp/le-cortege-preview.png)

The script syntax-checks inline JavaScript, starts Chromium, starts the game,
checks browser errors, labels, canvas output and horizontal overflow, then saves
a screenshot. In restricted Linux environments Chromium may need host permissions.`);
  process.exit(0);
}
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const browser = process.env.CHROMIUM || arg('--browser', 'chromium');
const width = Number(arg('--width', '400'));
const height = Number(arg('--height', '800'));
const seconds = Math.max(2, Number(arg('--seconds', '4')));
const screenshot = path.resolve(arg('--out', path.join(tmpdir(), 'le-cortege-preview.png')));
const source = path.resolve(arg('--page', path.join(project, 'index.html')));

if (!existsSync(source)) throw new Error(`Page not found: ${source}`);
if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(seconds)) {
  throw new Error('Width, height and seconds must be numbers.');
}

const scratch = mkdtempSync(path.join(tmpdir(), 'le-cortege-smoke-'));
const htmlPath = path.join(scratch, 'preview.html');
const probe = `
<script>
(() => {
  const errors = [];
  addEventListener('error', event => errors.push(event.message || 'Script error'));
  addEventListener('unhandledrejection', event => errors.push(String(event.reason || 'Unhandled promise rejection')));
  const canvas = document.querySelector('#game');
  const ctx = canvas.getContext('2d');
  let paintedRects = 0;
  const originalFillRect = ctx.fillRect.bind(ctx);
  ctx.fillRect = (...args) => { paintedRects++; return originalFillRect(...args); };
  canvas.requestPointerLock = () => {};
  setTimeout(() => document.querySelector('#start').click(), 500);
  setTimeout(() => {
    const state = window.__arcade.state;
    const missingLabels = [...document.querySelectorAll('[data-i]')]
      .filter(element => !element.textContent.trim() || /undefined|null/i.test(element.textContent))
      .map(element => element.dataset.i);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const samples = [];
    for (const y of [.08, .28, .5, .72, .92]) {
      for (const x of [.08, .28, .5, .72, .92]) {
        const offset = (Math.floor(canvas.height * y) * canvas.width + Math.floor(canvas.width * x)) * 4;
        samples.push(Array.from(image.slice(offset, offset + 4)).join(','));
      }
    }
    const distinctCanvasColors = new Set(samples).size;
    const details = {
      viewport: [innerWidth, innerHeight],
      documentWidth: document.documentElement.scrollWidth,
      canvas: [canvas.width, canvas.height],
      started: state.started,
      marchers: state.march.length,
      missingLabels,
      paintedRects,
      distinctCanvasColors,
      samples,
      errors
    };
    console.log('SMOKE_DETAILS ' + JSON.stringify(details));
    document.body.dataset.smoke = JSON.stringify(details);
    const badge = document.createElement('pre');
    badge.textContent = document.body.dataset.smoke;
    badge.style.cssText = 'position:fixed;z-index:99;top:2px;left:2px;max-width:98vw;white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;color:#111;padding:3px;font:10px monospace';
    document.body.append(badge);
    if (errors.length) console.error('SMOKE_PAGE_ERRORS ' + errors.join(' | '));
    if (document.documentElement.scrollWidth > innerWidth) console.error('SMOKE_HORIZONTAL_OVERFLOW');
    if (!state.started || state.march.length < 200) console.error('SMOKE_GAME_SETUP_FAILED');
    if (distinctCanvasColors < 6) console.error('SMOKE_SCENE_BLANK');
    if (missingLabels.length) console.error('SMOKE_MISSING_LABELS ' + missingLabels.join(', '));
  }, 1600);
})();
</script>`;

try {
  const html = readFileSync(source, 'utf8');
  if (!html.includes('</body>')) throw new Error('Page has no closing body tag.');
  const gameScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).filter(script => script.trim());
  if (!gameScripts.length) throw new Error('Page has no inline game script to lint.');
  const lintPath = path.join(scratch, 'game-scripts.js');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(lintPath, gameScripts.join('\n;\n')));
  const lint = spawnSync(process.execPath, ['--check', lintPath], { encoding: 'utf8' });
  if (lint.status !== 0) throw new Error(`JavaScript syntax check failed:\n${lint.stderr || lint.stdout}`);
  const prepared = html.replace('</body>', `${probe}\n</body>`);
  await import('node:fs/promises').then(({ writeFile }) => writeFile(htmlPath, prepared));
  mkdirSync(path.dirname(screenshot), { recursive: true });

  const child = spawn(browser, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-crash-reporter', '--disable-breakpad', '--disable-background-networking',
    '--disable-extensions', '--no-first-run', `--user-data-dir=${path.join(scratch, 'profile')}`,
    '--enable-logging=stderr', '--v=0', '--hide-scrollbars',
    '--run-all-compositor-stages-before-draw', `--virtual-time-budget=${seconds * 1000}`,
    '--force-device-scale-factor=1', `--window-size=${width},${height}`,
    `--screenshot=${screenshot}`, `file://${htmlPath}`
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timeout); resolve(code); });
  });

  const browserErrors = stderr.split('\n').filter(line => /INFO:CONSOLE|ERROR:CONSOLE/.test(line));
  if (browserErrors.length) process.stderr.write(browserErrors.join('\n') + '\n');
  if (exitCode !== 0) throw new Error(`Chromium exited with status ${exitCode}.`);
  if (!existsSync(screenshot)) throw new Error('Chromium did not write a screenshot.');
  if (browserErrors.some(line => /Uncaught|SMOKE_.*(ERROR|FAILED|OVERFLOW|MISSING)/.test(line))) {
    throw new Error('Browser smoke check reported an error.');
  }
  console.log(`Screenshot: ${screenshot}`);
  console.log(`Viewport: ${width}×${height}; page: ${source}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
