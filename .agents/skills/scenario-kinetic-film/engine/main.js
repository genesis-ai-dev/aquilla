// main.js: boot a film. Loads spec.js (the film), fonts, the logo and the film's own source, builds it,
// and exposes __seek / __samples / __shutter for the renderer and a scrubber for previewing.
import { configure, setPalette, DUR, FPS, BPM } from './core.js';
import { Film } from './compositor.js';

const spec = (await import('./spec.js')).default;
configure(spec);
setPalette(spec.palette || {});
await Promise.all(['900 100px Archivo', '500 20px JBM', '700 30px Inst', '400 30px Inst'].map(f => document.fonts.load(f)));
const files = ['spec.js', 'blocks.js', 'core.js', 'compositor.js', 'main.js', 'index.html'];
const texts = await Promise.all(files.map(u => fetch(u).then(r => (r.ok ? r.text() : ''))));
const src = { code: texts.slice(0, 2).join('\n'), lines: texts.reduce((n, s) => n + (s ? s.trimEnd().split('\n').length : 0), 0) };
// the logo is inlined as SVG markup, so anything active in the file is stripped first: scripts, embedded
// HTML, event handlers, and links or animations that point at javascript: (browsers ignore tabs, newlines
// and control characters in a URL, so "java&#9;script:" is checked without them)
const jsUrl = v => /^javascript:/i.test(v.replace(/[\s\u0000-\u001f]/g, ''));
function inertSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml'), svg = doc.documentElement;
  if (svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return '';
  svg.querySelectorAll('script, foreignObject, iframe, object, embed').forEach(n => n.remove());
  svg.querySelectorAll('set, animate').forEach(n => { if (/href|^on/i.test(n.getAttribute('attributeName') || '')) n.remove(); });
  for (const n of [svg, ...svg.querySelectorAll('*')])
    for (const a of [...n.attributes]) if (/^on/i.test(a.name) || (/href$/i.test(a.name) && jsUrl(a.value))) n.removeAttribute(a.name);
  return new XMLSerializer().serializeToString(svg);
}
const logo = spec.logo ? await fetch(spec.logo).then(r => (r.ok ? r.text() : '')).then(inertSvg) : '';

const film = new Film(document.getElementById('root'), { src, logo, spec });
window.__film = { title: spec.title || '', dur: DUR, fps: FPS, bpm: BPM, cues: film.cues, lines: src.lines, cuts: film.cuts(), music: spec.music || null, sounds: spec.sounds || {} };
window.__samples = (t, dt) => film.samples(t, dt);
window.__shutter = t => film.shutter(t);
window.__seek = t => film.render(t);
film.render(0);
window.__ready = true;

// preview: space plays, arrows step one beat, 0-9 jump to tenths of the film, ?t=12 starts at 12 s
if (!location.search.includes('render')) {
  let t = +(new URLSearchParams(location.search).get('t') || 0), playing = false, last = 0;
  const bar = document.createElement('input');
  Object.assign(bar, { type: 'range', min: 0, max: DUR, step: 1 / FPS, value: t });
  bar.className = 'scrub'; document.body.appendChild(bar);
  const label = document.createElement('div'); label.className = 'scrubt'; document.body.appendChild(label);
  const show = () => { film.render(t); bar.value = t; label.textContent = `${t.toFixed(2)} s  ·  beat ${(t * BPM / 60).toFixed(1)}`; };
  bar.oninput = () => { t = +bar.value; show(); };
  addEventListener('keydown', e => {
    if (e.code === 'Space') { playing = !playing; last = performance.now(); e.preventDefault(); }
    if (e.code === 'ArrowRight') { t = Math.min(DUR, t + 60 / BPM); show(); }
    if (e.code === 'ArrowLeft') { t = Math.max(0, t - 60 / BPM); show(); }
    if (/^Digit\d$/.test(e.code)) { t = DUR * (+e.code.slice(5)) / 10; show(); }
  });
  const loop = now => { if (playing) { t += (now - last) / 1000; if (t > DUR) t = 0; show(); } last = now; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  show();
}
