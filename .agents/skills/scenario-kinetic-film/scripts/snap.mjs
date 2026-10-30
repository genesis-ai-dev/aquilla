// snap.mjs <outdir> <dsf> t1 t2 ... : stills of the film at the given times (seconds), named t_<seconds>.png
// Times may also be beats: b12.5. Serve the film folder first (FILM_URL, default http://127.0.0.1:5671/).
import fs from 'fs';
import { launch, openFilm } from './browser.mjs';
const [OUT, DSF = '1', ...TS] = process.argv.slice(2);
if (!OUT || !TS.length) { console.error('usage: node snap.mjs <outdir> <dsf> <t|bBeat> ...'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const b = await launch();
const { pg, errs } = await openFilm(b, DSF);
const bpm = await pg.evaluate(() => window.__film && window.__film.bpm);
for (const raw of TS) {
  const t = raw.startsWith('b') ? +raw.slice(1) * 60 / bpm : +raw;
  const err = await pg.evaluate(t => { try { window.__seek(t); return null; } catch (e) { return e.message.slice(0, 160); } }, t);
  if (err) { errs.push(`SEEK ${raw}: ${err}`); continue; }
  await pg.screenshot({ path: `${OUT}/t_${t.toFixed(2).padStart(6, '0')}.png`, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
}
console.log('lines', await pg.evaluate(() => window.__film && window.__film.lines), errs.length ? 'ERRORS ' + JSON.stringify(errs.slice(0, 8)) : 'no errors');
await b.close();
