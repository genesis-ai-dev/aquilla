// browser.mjs: shared by the scripts. Finds Playwright (this folder, the film folder, or a global install),
// launches Chrome with the flags a frame-exact capture needs, and knows where the film is served (FILM_URL).
import { createRequire } from 'module';
import { execSync } from 'child_process';
function loadPlaywright() {
  const bases = [process.cwd() + '/', import.meta.url];
  try { bases.push(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() + '/'); } catch {}
  for (const b of bases) { try { return createRequire(b)('playwright'); } catch {} }
  console.error('Playwright not found. In the film folder run: npm install playwright (and npx playwright install chromium if Google Chrome is not installed).');
  process.exit(2);
}
export const { chromium } = loadPlaywright();
// --run-all-compositor-stages-before-draw: without it, big 3D layers are captured half rastered
export async function launch() {
  const args = ['--run-all-compositor-stages-before-draw', '--disable-checker-imaging', '--ignore-gpu-blocklist', '--enable-gpu'];
  if (process.platform === 'darwin') args.push('--use-angle=metal');
  try { return await chromium.launch({ channel: 'chrome', args }); } catch { return await chromium.launch({ args }); }
}
export const FILM_URL = (process.env.FILM_URL || 'http://127.0.0.1:5671/').replace(/\/?$/, '/');
// headless Chrome keeps about 90 px of window chrome: a 1920x1080 viewport would paint only ~990 px of the stage
export async function openFilm(b, dsf = 1, render = true) {
  const pg = await b.newPage({ viewport: { width: 1920, height: 1300 }, deviceScaleFactor: +dsf });
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGE ' + e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
  await pg.goto(FILM_URL + 'index.html' + (render ? '?render=1' : ''));
  await pg.waitForFunction(() => window.__ready, null, { timeout: 120000 }).catch(e => errs.push('TIMEOUT ' + e.message));
  return { pg, errs };
}
