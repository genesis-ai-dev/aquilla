// info.mjs [out.json]: what the renderer and mixer need from the film: title, duration, fps, bpm, music, cuts and every sound cue.
import fs from 'fs';
import { launch, openFilm } from './browser.mjs';
const b = await launch();
const { pg, errs } = await openFilm(b, 1);
const f = await pg.evaluate(() => window.__film ? { title: __film.title, dur: __film.dur, fps: __film.fps, bpm: __film.bpm, music: __film.music, sounds: __film.sounds, cuts: __film.cuts, lines: __film.lines, cues: __film.cues } : null);
await b.close();
if (!f) { console.error('film did not load', errs); process.exit(1); }
if (errs.length) console.error('page errors:', errs.slice(0, 5));
const s = JSON.stringify(f);
if (process.argv[2]) fs.writeFileSync(process.argv[2], s); else console.log(s);
process.exit(0);
