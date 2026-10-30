// render.mjs <dsf> <frame0> <frame1> [maxSamples] [jpegQuality]   (used by post.py; serve the film at FILM_URL first)
// Streams to stdout, per output frame: u32 frame, u32 n, then n x (u32 len, jpeg bytes).
// Motion blur: n sub-frame samples over a forward 180 degree shutter (longer in smear windows), never across a hard cut;
// a cut inside the shutter slides the window back so the fastest frame of a whip still blurs.
import { launch, openFilm } from './browser.mjs';
const [DSF, F0, F1, MAXS = '99', Q = '95'] = process.argv.slice(2);
const b = await launch();
const { pg, errs } = await openFilm(b, DSF);
const { cuts, fps } = await pg.evaluate(() => ({ cuts: window.__film.cuts, fps: window.__film.fps }));
const cdp = await pg.context().newCDPSession(pg);
const DT = .5 / fps, out = process.stdout;
const write = buf => new Promise(r => out.write(buf) ? r() : out.once('drain', r));
const st = Date.now();
for (let k = +F0; k < +F1; k++) {
  const t = k / fps;
  const sh = await pg.evaluate(t => window.__shutter ? window.__shutter(t) : 1, t);
  let st0 = t, end = t + DT * sh;
  for (const c of cuts) if (c > t + 1e-6 && c < end) { end = c - 1e-4; st0 = Math.max(end - DT * sh, t - DT * sh); }
  for (const c of cuts) if (c > st0 && c <= t) st0 = c;
  const n = Math.min(+MAXS, await pg.evaluate(([t, dt]) => window.__samples(t, dt), [st0, end - st0]));
  await pg.evaluate(ft => { window.__frameT = ft; }, t);
  const hdr = Buffer.alloc(8); hdr.writeUInt32LE(k, 0); hdr.writeUInt32LE(n, 4); await write(hdr);
  for (let j = 0; j < n; j++) {
    const ts = n === 1 ? t : st0 + (end - st0) * j / (n - 1);
    await pg.evaluate(ts => new Promise(r => { window.__seek(ts); requestAnimationFrame(() => r()); }), ts);
    // clip.scale must equal the device scale factor, or a 4K capture comes back at 1080p
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: +Q, optimizeForSpeed: true, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: +DSF } });
    const jb = Buffer.from(data, 'base64'), lb = Buffer.alloc(4); lb.writeUInt32LE(jb.length, 0);
    await write(lb); await write(jb);
  }
  if ((k - F0) % 120 === 0) process.stderr.write(`[${F0}-${F1}] frame ${k} ${((Date.now() - st) / 1000).toFixed(0)}s\n`);
}
if (errs.length) process.stderr.write('PAGE ERRORS ' + JSON.stringify(errs.slice(0, 5)) + '\n');
await new Promise(r => out.end(r));
await Promise.race([b.close(), new Promise(r => setTimeout(r, 4000))]);
process.exit(0);
