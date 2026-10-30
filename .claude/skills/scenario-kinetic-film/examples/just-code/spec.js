// spec.js: "Just code", the 51.8 s film this skill was distilled from, written as blocks on a beat grid.
// Every number below is a beat of the music (60 / bpm seconds). Blocks: blocks.js. Method: SKILL.md.
import { Words, Strike, Graph, Hero, Prompt, Stretch, Fly, Notes, Counters, Progress, Chain, Rewind, Logo } from './blocks.js';

const BRIEF = [['A 52-second film: heavy '], ['kinetic type', 1], [', one '], ['glowing line', 1], [' through every scene, '], ['3D letters', 1], [' the '], ['camera flies through', 1], [', and a '], ['hard cut', 1], [' on every beat.']];
const chars = BRIEF.reduce((n, [s]) => n + s.length, 0);

export default {
  title: 'Just code',
  bpm: 173.75, beats: 150, fps: 60,
  palette: { bg: '#0C0E11', paper: '#F4F1EA', accent: '#FF5B2E', hot: '#FF3A0A', ink: '#141210' },
  hud: 'SCENARIO  ·  FILM.JS', hudOut: [146, 148],
  logo: 'logo.svg',
  music: { file: 'audio/music.mp3', offset: 6.946, stopBeat: 140 },

  scenes: [
    // 1. Every frame of this film is code. A point charges, EVERY punches out of it, then one idea per beat.
    [Words, 0, 9, { charge: true, shots: [
      { at: 1, style: 'punch3d', text: 'EVERY', fx: 'punch' },
      { at: 2, style: 'slam', text: 'FRAME', ground: 'accent' },
      { at: 3, style: 'stack', text: ['OF THIS', 'FILM'], ground: 'paper', in: 'whipX', fx: 'none' },
      { at: 4.5, style: 'split', text: ['IS', 'CODE.'], in: 'whipY', fx: 'punch', big: true, code: true, scramble: [2.1, 3.6], glitch: 2.5, note: '// film.js · render(t)', noteAt: 1.5 },
    ], exit: { type: 'zoom', at: 8.1, char: 1 } }],

    // 2. No timeline. No plugins. No render farm.
    [Strike, 9, 19, { items: [
      { at: 9, word: 'TIMELINE.', ui: { type: 'timeline' } },
      { at: 12, word: 'PLUGINS.', ground: 'paper', ui: { type: 'tiles', tiles: [['GLOW', '☀', 'PLUG-IN · v2.0'], ['CAMERA SHAKE', '⌇', 'PLUG-IN · v3.7'], ['TEXT ANIMATOR', 'T', 'PLUG-IN · v4.4'], ['3D EXTRUDE', '▧', 'PLUG-IN · v2.1'], ['MOTION TRAILS', '≡', 'PLUG-IN · v3.8'], ['TURBULENCE', '∿', 'PLUG-IN · v4.5'], ['PARTICLES', '∴', 'PLUG-IN · v2.2'], ['LENS FLARE', '✵', 'PLUG-IN · v3.9']] } },
      { at: 15, word: 'RENDER FARM.', ui: { type: 'rack', rows: ['RENDER NODE 01', 'RENDER NODE 02', 'RENDER NODE 03'] } },
    ] }],

    // 3. Not one keyframe dragged by hand. The camera rides the comet, then flies through the 0.
    [Graph, 19, 25, { number: '0', label: 'KEYFRAMES', sub: 'DRAGGED BY HAND' }],

    // 4. Claude Opus 5.5 wrote it.
    [Hero, 25, 33, { kicker: 'WRITTEN BY', title: 'OPUS 5.5', sub: 'in Claude Code', whipOut: [0, 1150, .13] }],

    // 5. It got one brief. The push into Enter is the drop.
    [Prompt, 33, 52, { label: 'BRIEF.md', text: BRIEF }],

    // 6-8. The brief's promises, each shown full screen.
    [Stretch, 52, 60, { word: 'ELASTIC.', whipOut: [1800, 0, .14, -3] }],
    [Fly, 60, 71, { words: [['CAMERA', 'paper'], ['FLIES', 'accent'], ['THROUGH', 'paper'], ['THE TYPE.', 'accent']] }],
    [Words, 71, 77, { shots: [
      { at: 71, style: 'cut', text: 'CUT', color: 'paper', size: 380, rot: -3, fx: 'beat' },
      { at: 72, style: 'cut', text: 'ON', ground: 'accent', size: 560, rot: 4, fx: 'beat' },
      { at: 73, style: 'cut', text: 'EVERY', color: 'accent', size: 380, wdth: 118, rot: -2, fx: 'beat' },
      { at: 74, style: 'cut', text: 'BEAT.', ground: 'paper', size: 440, fx: 'beat' },
      { at: 74.5, style: 'cut', text: 'BEAT.', color: 'accent', size: 300, rot: 8, dy: -140, fx: 'beat' },
      { at: 75, style: 'cut', text: 'BEAT.', ground: 'accent', size: 540, rot: -6, dy: 20, fx: 'beat' },
      { at: 75.5, style: 'cut', text: 'BEAT.', ground: 'paper', size: 380, rot: 3, stroke: 4, fx: 'beat' },
      { at: 75.75, style: 'cut', text: 'BEAT.', color: 'paper', size: 620, rot: -4, rgb: true, fx: 'beat' },
    ], exit: { type: 'flash', at: 76 } }],

    // 9. Notes? Just type them.
    [Notes, 77, 93, { preview: 'ELASTIC.', tag: 'PREVIEW  ·  00:18', file: 'film.js', notes: [['hotter orange', 'recolor'], ['cut the intro in half', 'trim'], ['more punch', 'punch']] }],

    // 10. The whole film is one web page. Rendered on a laptop.
    [Counters, 93, 104, { title: 'film / scenes.js', counters: [['1', 'WEB PAGE'], ['{lines}', 'LINES OF CODE'], ['{frames}', 'FRAMES. ALL CODE.']], whipOut: [1700, 0, .13, 2] }],
    [Progress, 104, 113, { lines: ['RENDERED', 'ON A LAPTOP.'], doneRight: 'ON A LAPTOP', whipOut: [1700, 0, .13, -2],
      cards: [['EVERY', 'bg', 'paper'], ['FRAME', 'accent', 'ink'], ['FILM', 'paper', 'ink'], ['CODE.', 'bg', 'accent'], ['NO', 'bg', 'accent'], ['0', 'paper', 'ink'], ['OPUS 5.5', 'bg', 'paper'], ['ELASTIC.', 'accent', 'ink'], ['FLIES', 'bg', 'accent'], ['CUT', 'bg', 'paper'], ['BEAT.', 'paper', 'ink'], ['ON', 'accent', 'ink'], ['FILM.', 'bg', 'accent'], ['JUST', 'accent', 'ink']] }],

    // 11. Brief in. Film out.
    [Chain, 113, 125, { nodes: [['BRIEF', `brief.md · ${chars} chars`], ['CODE', 'film.js · {lines} lines'], ['FILM.', '4K · 60 FPS · {seconds} S']], whipOut: [0, -1100, .13] }],

    // 12. Everything you just watched, rewinding inside itself.
    [Rewind, 125, 133, {}],

    // 13. Every frame. Just code. Then everything collapses into the point the logo line grows from.
    [Words, 133, 140, { shots: [
      { at: 133, style: 'pair', text: ['EVERY', 'FRAME.'], fx: 'beat', cue: 'impact', gain: .7 },
      { at: 135, style: 'slam', text: 'JUST', ground: 'accent', size: 540, wdth: 110, echo: false, in: 'whipY', fx: 'beat' },
      { at: 136, style: 'slam', text: 'CODE.', ground: 'paper', size: 440, wdth: 104, dot: true, from: 1.8, fx: 'punch', big: true, glyphs: true, scramble: [1, 2], inverts: [1, 1.5], flip: { at: 2, ground: 'bg', color: 'paper' } },
    ], exit: { type: 'collapse', at: 138.2, end: 139.6 } }],

    // 14. Logo. The greyscale lockup: the four marks drop in, then the wordmark wipes on.
    [Logo, 139, 150, { mark: ['path11', 'path10', 'path9', 'path8'], word: ['Path', 'path1', 'path2', 'path3', 'path4', 'path5', 'path6', 'path7'], tagline: 'Motion design, written in code.', small: 'MADE WITH CLAUDE OPUS 5.5' }],
  ],

  // the caption line, top left: [startBeat, endBeat, [[word, beat], ...]]
  captions: [
    [0, 8.6, [['Every', 1], ['frame', 2], ['of', 3], ['this', 3.25], ['film', 3.5], ['is', 4.6], ['code.', 5]]],
    [9, 18.8, [['No', 10], ['timeline.', 10.4], ['No', 13], ['plugins.', 13.4], ['No', 16.5], ['render', 16.9], ['farm.', 17.3]]],
    [19, 24.6, [['Not', 19.2], ['one', 19.8], ['keyframe', 20.4], ['dragged', 21.4], ['by', 22.2], ['hand.', 22.7]]],
    [25, 32.5, [['Claude', 25.2], ['Opus', 26.2], ['5.5', 27], ['wrote', 28.6], ['it.', 29.4]]],
    [33, 49.2, [['It', 33.3], ['got', 33.9], ['one', 34.5], ['brief.', 35.2]]],
    [52, 59.4, [['Letters', 52.1], ['that', 53], ['stretch', 53.6], ['on', 54.8], ['a', 55.2], ['variable', 55.6], ['axis.', 56.8]]],
    [60, 70.5, [['A', 60.2], ['camera', 60.8], ['that', 62], ['flies', 62.7], ['through', 63.6], ['the', 64.6], ['type.', 65.2]]],
    [71, 76.4, [['And', 71], ['a', 71.4], ['cut', 71.8], ['on', 72.4], ['every', 73.1], ['beat.', 74.1]]],
    [77, 92.4, [['Notes?', 77.3], ['Just', 78.6], ['type', 79.2], ['them.', 79.8]]],
    [93, 103.4, [['The', 93.3], ['whole', 93.9], ['film', 94.6], ['is', 95], ['one', 95.3], ['web', 95.7], ['page.', 96.1]]],
    [104, 112.4, [['Rendered', 104.3], ['on', 105.1], ['a', 105.4], ['laptop.', 105.7]]],
    [113, 124.4, [['Brief', 113.6], ['in.', 114.2], ['Film', 117.6], ['out.', 120]]],
    [125, 132.4, [['Everything', 125.2], ['you', 126.6], ['just', 127.2], ['watched.', 127.8]]],
    [133, 138.2, [['Every', 133], ['frame.', 133.5], ['Just', 135], ['code.', 136]]],
  ],
};
