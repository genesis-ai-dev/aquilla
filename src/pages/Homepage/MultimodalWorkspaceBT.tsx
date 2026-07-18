// The homepage centerpiece: ONE source verse, rendered across every medium —
// text, audio, video, image, oral story — inside a single faithful "workspace"
// frame. Reuses the real HealthRing and the app's global karaoke CSS class so
// the demo reads as the actual product. "Hear it" uses the Web Speech API
// (instant, no model download) and drives a karaoke highlight + canvas waveform
// off one deterministic timeline, so the visual is always smooth even where
// speech synthesis is unavailable.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HealthRing } from "@/components/HealthRing"

type Mode = "text" | "audio" | "video" | "image" | "story"

const VERSE = {
  ref: "John 3:16",
  sourceLang: "English · source",
  source:
    "For God so loved the world, that he gave his only Son, that whoever believes in him should not perish but have eternal life.",
  targetLang: "Spanish · draft",
  targetTag: "es",
  // Reina-Valera (public domain) — an accurate, recognizable rendering.
  target:
    "Porque de tal manera amó Dios al mundo, que ha dado a su Hijo unigénito, para que todo aquel que en él cree no se pierda, mas tenga vida eterna.",
}

const MODES: { id: Mode; label: string; icon: React.ReactNode }[] = [
  { id: "text", label: "Text", icon: <IconText /> },
  { id: "audio", label: "Audio", icon: <IconAudio /> },
  { id: "video", label: "Video", icon: <IconVideo /> },
  { id: "image", label: "Image", icon: <IconImage /> },
  { id: "story", label: "Story", icon: <IconStory /> },
]

const MODE_NOTE: Record<Mode, React.ReactNode> = {
  text: <>One verse, written. <span className="aq-mono">live rules + back-translation as you type.</span></>,
  audio: <>The same verse, spoken. <span className="aq-mono">record oral renderings, verse by verse.</span></>,
  video: <>The same verse, captioned. <span className="aq-mono">subtitles and dubs synced to video playback.</span></>,
  image: <>The same verse, on an image. <span className="aq-mono">coming soon — caption overlays for scripture art and slides.</span></>,
  story: <>The same verse, retold. <span className="aq-mono">coming soon — oral-first story panels for listening communities.</span></>,
}

export function MultimodalWorkspace({ theme = "dark" }: { theme?: "light" | "dark" }) {
  const [mode, setMode] = useState<Mode>("text")

  return (
    <div className="aq-window">
      <div className="aq-window-glow" aria-hidden="true" />
      <div className="aq-window-bar">
        <span className="aq-traffic" aria-hidden="true"><i /><i /><i /></span>
        <span className="aq-window-title">
          <IconAquila />
          <span className="aq-mono">{VERSE.ref}</span>
          <span style={{ opacity: 0.5 }}>· one source, every medium</span>
        </span>
      </div>

      <div className="aq-modes" role="tablist" aria-label="Translation medium">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            aria-controls={`aq-ws-panel-${m.id}`}
            id={`aq-ws-tab-${m.id}`}
            data-active={mode === m.id}
            className="aq-mode"
            onClick={() => setMode(m.id)}
          >
            <span className="aq-mode-ico">{m.icon}</span>
            {m.label}
          </button>
        ))}
      </div>

      <div
        className="aq-ws-body"
        role="tabpanel"
        id={`aq-ws-panel-${mode}`}
        aria-labelledby={`aq-ws-tab-${mode}`}
      >
        {mode === "text" && <TextPanel theme={theme} />}
        {mode === "audio" && <AudioPanel theme={theme} />}
        {mode === "video" && <VideoPanel />}
        {mode === "image" && <ImagePanel />}
        {mode === "story" && <StoryPanel />}
      </div>

      <div className="aq-ws-note">
        <IconSpark />
        {MODE_NOTE[mode]}
      </div>
    </div>
  )
}

/* ── Text panel: source + target, karaoke "Hear it", waveform, health ────── */
function TextPanel({ theme }: { theme: "light" | "dark" }) {
  const words = useMemo(() => VERSE.target.split(/\s+/), [])
  const { playing, activeIndex, progress, health, play, stop } = useSpeech(words, VERSE.targetTag)

  return (
    <div className="aq-panel">
      <div className="aq-ws-grid">
        <div className="aq-cell aq-cell-source">
          <div className="aq-cell-head">
            <span className="aq-cell-lang"><span className="aq-flag" style={{ background: "linear-gradient(180deg,#60a5fa,#1e3a8a)" }} /> {VERSE.sourceLang}</span>
            <span>locked</span>
          </div>
          <p className="aq-cell-text">{VERSE.source}</p>
          <div className="aq-cell-foot">
            <span className="aq-cell-status"><IconLock /> Source of truth</span>
          </div>
        </div>

        <div className="aq-cell">
          <div className="aq-cell-head">
            <span className="aq-cell-lang"><span className="aq-flag" style={{ background: "linear-gradient(180deg,#f4c430,#c8102e)" }} /> {VERSE.targetLang}</span>
            <span>you · editing</span>
          </div>
          <p className="aq-cell-text">
            {words.map((w, i) => (
              <span key={i} className={"aq-word" + (i === activeIndex ? " karaoke-active" : "")}>
                {w}{i < words.length - 1 ? " " : ""}
              </span>
            ))}
            {!playing && <span className="aq-caret" aria-hidden />}
          </p>
          <div className="aq-cell-foot">
            <span className="aq-cell-status">
              <HealthRing health={health} size={18} strokeWidth={2.5}>
                {health >= 67 ? <IconCheckTiny /> : null}
              </HealthRing>
              {health}% support
            </span>
            <button
              className="aq-play"
              data-busy={playing}
              onClick={() => (playing ? stop() : play())}
              aria-label={playing ? "Stop" : "Hear the translation"}
            >
              {playing ? <IconPause /> : <IconPlay />}
              {playing ? "Playing…" : "Hear it"}
            </button>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <Waveform progress={progress} active={playing} seed={VERSE.target} height={56} theme={theme} />
      </div>
    </div>
  )
}

/* ── Audio panel: verse-by-verse oral capture ───────────────────────────── */
function AudioPanel({ theme }: { theme: "light" | "dark" }) {
  const rows = [
    { ref: "3:16", dur: "0:12", health: 91, seed: "amor del mundo entero", rec: false },
    { ref: "3:17", dur: "0:09", health: 78, seed: "no para condenar al mundo", rec: false },
    { ref: "3:18", dur: "—", health: 0, seed: "el que en el cree no es condenado", rec: true },
  ]
  return (
    <div className="aq-panel">
      <div className="aq-cell-head" style={{ marginBottom: 14 }}>
        <span className="aq-cell-lang"><IconMic /> Oral rendering · Spanish</span>
        <span>verse by verse</span>
      </div>
      {rows.map((r) => (
        <div className="aq-verse-row" key={r.ref}>
          <span className="aq-verse-ref aq-mono">{r.ref}</span>
          {r.rec ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
              <span className="aq-eq" aria-hidden>
                <i style={{ height: "70%" }} /><i style={{ height: "40%" }} /><i style={{ height: "100%" }} /><i style={{ height: "55%" }} /><i style={{ height: "80%" }} />
              </span>
              <span style={{ fontSize: 12.5, color: "var(--aq-blue-soft)" }}>Recording…</span>
            </span>
          ) : (
            <Waveform progress={r.ref === "3:16" ? 0.62 : 0.2} active={false} seed={r.seed} height={30} variant="blue" theme={theme} />
          )}
          {r.rec ? (
            <span className="aq-mono aq-dur" style={{ color: "var(--aq-blue-soft)" }}>0:04</span>
          ) : (
            <span className="aq-mono aq-dur">{r.dur}</span>
          )}
          {r.rec ? (
            <span aria-hidden="true" className="aq-eq-dot" style={{ width: 10, height: 10, borderRadius: 999, background: "#ef4444", boxShadow: "0 0 10px #ef4444" }} />
          ) : (
            <HealthRing health={r.health} size={18} strokeWidth={2.5}>
              {r.health >= 67 ? <IconCheckTiny /> : null}
            </HealthRing>
          )}
        </div>
      ))}
      <p style={{ marginTop: 16, fontSize: 13.5, color: "var(--aq-faint)", lineHeight: 1.5 }}>
        Text and audio live in the same cell. Edit the words, and the recording is right there beside them — for communities where Scripture is heard before it is read.
      </p>
    </div>
  )
}

/* ── Video panel: translated captions synced to playback ────────────────── */
function VideoPanel() {
  const cues = [
    "Porque de tal manera amó Dios al mundo,",
    "que ha dado a su Hijo unigénito,",
    "para que todo aquel que en él cree… tenga vida eterna.",
  ]
  const [cue, setCue] = useState(0)
  const [prog, setProg] = useState(0)

  useEffect(() => {
    const start = performance.now()
    const total = 9000
    let raf = 0
    const tick = (now: number) => {
      const t = ((now - start) % total) / total
      setProg(t)
      setCue(Math.min(cues.length - 1, Math.floor(t * cues.length)))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="aq-panel">
      <div className="aq-video">
        <DawnScene />
        <div className="aq-video-grain" />
        <div className="aq-video-play"><span><IconPlay /></span></div>
        <div className="aq-video-caption">
          <span className="aq-cap-tag">Subtítulo · ES</span>
          <div>{cues[cue]}</div>
        </div>
        <div className="aq-video-bar"><i style={{ width: `${prog * 100}%` }} /></div>
      </div>
      {/* SWARM-TODO(homepage-copy): "JESUS Film" brand name — confirm capitalization/trademark usage is correct */}
      <p style={{ marginTop: 16, fontSize: 13.5, color: "var(--aq-faint)", lineHeight: 1.5 }}>
        Sermons, the <span style={{ color: "var(--aq-dim)" }}>JESUS Film</span>, scripted lessons — caption and dub them against the same source text and the same project memory, with timings that stay in sync.
      </p>
    </div>
  )
}

/* ── Image panel: captions + embedded text in any language ──────────────── */
function ImagePanel() {
  const langs = [
    { tag: "ES", text: "Porque de tal manera amó Dios al mundo…" },
    { tag: "FR", text: "Car Dieu a tant aimé le monde…" },
    { tag: "EN", text: "For God so loved the world…" },
  ]
  const [i, setI] = useState(0)
  return (
    <div className="aq-panel">
      <div className="aq-ws-grid" style={{ alignItems: "center" }}>
        <div className="aq-scene">
          <PearlScene />
          <div className="aq-scene-caption">{langs[i].text}</div>
        </div>
        <div>
          <h4 className="aq-display" style={{ fontSize: 22 }}>Captions &amp; embedded text <span style={{ fontSize: 13, fontWeight: 400, color: "var(--aq-faint)" }}>(coming soon)</span></h4>
          <p style={{ marginTop: 12, fontSize: 14.5, color: "var(--aq-dim)", lineHeight: 1.55 }}>
            Translate caption overlays for memory verses, scripture art, and lesson slides. This mode is exploratory — shape it early by sharing your use case.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            {langs.map((l, idx) => (
              <button
                key={l.tag}
                className="aq-mode"
                data-active={i === idx}
                onClick={() => setI(idx)}
                style={{ padding: "7px 13px" }}
              >
                {l.tag}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Story panel: oral-first story strip ────────────────────────────────── */
function StoryPanel() {
  const panels = [
    { n: 1, art: <StoryGlobe />, cap: "Dios creó el mundo y lo amó." },
    { n: 2, art: <StoryGift />, cap: "Entregó a su único Hijo." },
    { n: 3, art: <StoryDawn />, cap: "Todo el que cree vivirá para siempre." },
  ]
  return (
    <div className="aq-panel">
      <div className="aq-cell-head" style={{ marginBottom: 16 }}>
        <span className="aq-cell-lang"><IconStory /> Oral story · Spanish</span>
        <span style={{ color: "var(--aq-faint)", fontSize: 12 }}>coming soon</span>
      </div>
      <div className="aq-story-strip">
        {panels.map((p) => (
          <div className="aq-story-panel" key={p.n}>
            <div className="aq-story-art">{p.art}</div>
            <span className="aq-story-num aq-mono">0{p.n}</span>
            <span className="aq-story-cap">{p.cap}</span>
          </div>
        ))}
      </div>
      <p style={{ marginTop: 18, fontSize: 13.5, color: "var(--aq-faint)", lineHeight: 1.5 }}>
        Oral-first story panels for listening communities — exploratory. Share your use case to help shape this mode.
      </p>
    </div>
  )
}

/* ── Speech + karaoke timeline ──────────────────────────────────────────── */
function useSpeech(words: string[], lang: string) {
  const [playing, setPlaying] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [progress, setProgress] = useState(0)
  const [health, setHealth] = useState(71)
  const rafRef = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    try { window.speechSynthesis?.cancel() } catch { /* no speech */ }
    setPlaying(false)
    setActiveIndex(-1)
    setProgress(0)
  }, [])

  const play = useCallback(() => {
    // Deterministic per-word timeline — drives both highlight and waveform.
    const per = 230
    const durs = words.map((w) => Math.max(170, per * (0.45 + w.replace(/[.,…]/g, "").length / 6)))
    const total = durs.reduce((a, b) => a + b, 0)
    const starts: number[] = []
    durs.reduce((acc, d, i) => { starts[i] = acc; return acc + d }, 0)

    try {
      const synth = window.speechSynthesis
      if (synth) {
        synth.cancel()
        const u = new SpeechSynthesisUtterance(words.join(" "))
        u.lang = lang === "es" ? "es-ES" : lang
        u.rate = 0.95
        const v = synth.getVoices().find((vc) => vc.lang?.toLowerCase().startsWith("es"))
        if (v) u.voice = v
        synth.speak(u)
      }
    } catch { /* visual timeline still runs */ }

    setPlaying(true)
    const t0 = performance.now()
    const loop = (now: number) => {
      const t = now - t0
      const p = Math.min(1, t / total)
      setProgress(p)
      let idx = words.length - 1
      for (let i = 0; i < starts.length; i++) { if (t < starts[i]) { idx = i - 1; break } }
      setActiveIndex(Math.max(0, idx))
      if (t < total) {
        rafRef.current = requestAnimationFrame(loop)
      } else {
        rafRef.current = null
        setPlaying(false)
        setActiveIndex(-1)
        setProgress(1)
        setHealth(94) // hearing it back validates the draft
      }
    }
    rafRef.current = requestAnimationFrame(loop)
  }, [words, lang])

  useEffect(() => () => stop(), [stop])
  return { playing, activeIndex, progress, health, play, stop }
}

/* ── Canvas waveform ────────────────────────────────────────────────────── */
function Waveform({
  progress, active, seed, height = 56, variant = "gold", theme = "dark",
}: { progress: number; active: boolean; seed: string; height?: number; variant?: "gold" | "blue"; theme?: "light" | "dark" }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const bars = useMemo(() => makeBars(seed, 96), [seed])
  // Holds the latest draw closure so the mount-only ResizeObserver below can
  // repaint with current props without re-subscribing every render.
  const drawRef = useRef<() => void>(() => {})

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      // The canvas is width:100% — before layout settles (or while its panel is
      // off-screen) clientWidth/Height can be 0. Drawing then yields a negative
      // bar width and a negative arcTo radius, which throws. Skip until sized;
      // the ResizeObserver repaints once real dimensions arrive.
      if (w <= 0 || h <= 0) return
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const gap = 2
      const bw = Math.max(1, (w - gap * (bars.length - 1)) / bars.length)
      const mid = h / 2
      const playX = progress * w

      const light = theme === "light"
      const litTop = variant === "blue" ? (light ? "#2e9fd8" : "#86e0ff") : (light ? "#4a93e6" : "#bfe0ff")
      const litBot = variant === "blue" ? (light ? "#1366b8" : "#1fa9d8") : (light ? "#1f5fc4" : "#4d97e8")
      const trackColor = light ? "rgba(30,41,82,0.16)" : "rgba(255,255,255,0.14)"
      const playhead = variant === "blue" ? (light ? "#1366b8" : "#bdf0ff") : (light ? "#1f5fc4" : "#cfe6ff")

      for (let i = 0; i < bars.length; i++) {
        const x = i * (bw + gap)
        const bh = Math.max(2, bars[i] * (h - 6))
        const lit = x <= playX
        if (lit) {
          const g = ctx.createLinearGradient(0, mid - bh / 2, 0, mid + bh / 2)
          g.addColorStop(0, litTop)
          g.addColorStop(1, litBot)
          ctx.fillStyle = g
        } else {
          ctx.fillStyle = trackColor
        }
        roundRect(ctx, x, mid - bh / 2, bw, bh, Math.min(bw / 2, 2))
        ctx.fill()
      }

      if (active && progress > 0 && progress < 1) {
        ctx.fillStyle = playhead
        ctx.fillRect(playX - 0.5, 4, 1.5, h - 8)
      }
    }
    drawRef.current = draw
    draw()
    // No deps array: the draw is cheap and inputs (progress/theme/…) change via
    // re-render anyway. A fixed-length deps array is avoided so the React
    // Compiler can't trip the "deps size changed" guard.
  })

  // Repaint when the canvas first gains a size (or is resized). clientWidth can
  // be 0 on the initial effect with no follow-up render to trigger a redraw, so
  // without this the waveform would stay blank until an unrelated re-render.
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => drawRef.current())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="aq-wave" style={{ height }} aria-hidden="true">
      <canvas ref={ref} />
    </div>
  )
}

function makeBars(seed: string, n: number): number[] {
  let s = 0
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff }
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const env = Math.sin((i / n) * Math.PI) // speech-like envelope
    const syl = 0.55 + 0.45 * Math.abs(Math.sin(i * 0.7 + rand() * 2))
    out.push(Math.max(0.08, Math.min(1, env * syl * (0.7 + rand() * 0.5))))
  }
  return out
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  // arcTo throws on a negative radius; clamp so a degenerate bar can never crash.
  r = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/* ── Inline scenes (CSS-gradient + SVG motifs, no external media) ────────── */
function DawnScene() {
  return (
    <svg className="aq-video-scene" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <radialGradient id="aqSun" cx="50%" cy="70%" r="60%">
          <stop offset="0%" stopColor="#dcefff" />
          <stop offset="55%" stopColor="#5aa9ff" />
          <stop offset="100%" stopColor="#5aa9ff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="aqHills" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1b2746" />
          <stop offset="100%" stopColor="#0f172a" />
        </linearGradient>
      </defs>
      <circle cx="160" cy="120" r="70" fill="url(#aqSun)" opacity="0.85" />
      <path d="M0 132 Q70 104 140 124 T320 116 V180 H0 Z" fill="url(#aqHills)" opacity="0.92" />
      <path d="M0 150 Q90 126 180 146 T320 140 V180 H0 Z" fill="#0b1220" opacity="0.9" />
    </svg>
  )
}

function PearlScene() {
  return (
    <svg viewBox="0 0 320 240" preserveAspectRatio="xMidYMid slice" aria-hidden style={{ width: "100%", height: "100%", display: "block" }}>
      <defs>
        <linearGradient id="aqBg2" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#202a4d" />
          <stop offset="100%" stopColor="#0e1426" />
        </linearGradient>
        <radialGradient id="aqPearl" cx="40%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="45%" stopColor="#dbeaff" />
          <stop offset="100%" stopColor="#5b8fd6" />
        </radialGradient>
      </defs>
      <rect width="320" height="240" fill="url(#aqBg2)" />
      <g opacity="0.5" stroke="#5aa9ff" strokeWidth="1">
        <line x1="160" y1="120" x2="160" y2="14" /><line x1="160" y1="120" x2="266" y2="120" />
        <line x1="160" y1="120" x2="160" y2="226" /><line x1="160" y1="120" x2="54" y2="120" />
        <line x1="160" y1="120" x2="236" y2="44" /><line x1="160" y1="120" x2="236" y2="196" />
        <line x1="160" y1="120" x2="84" y2="196" /><line x1="160" y1="120" x2="84" y2="44" />
      </g>
      <circle cx="160" cy="120" r="40" fill="url(#aqPearl)" />
      <circle cx="146" cy="106" r="10" fill="#ffffff" opacity="0.7" />
    </svg>
  )
}

function StoryGlobe() { return <StoryTile><circle cx="32" cy="32" r="20" fill="none" stroke="#5aa9ff" strokeWidth="2" /><ellipse cx="32" cy="32" rx="9" ry="20" fill="none" stroke="#9ec5ff" strokeWidth="1.5" /><line x1="12" y1="32" x2="52" y2="32" stroke="#9ec5ff" strokeWidth="1.5" /></StoryTile> }
function StoryGift() { return <StoryTile><rect x="16" y="26" width="32" height="26" rx="3" fill="none" stroke="#5aa9ff" strokeWidth="2" /><path d="M16 34 H48" stroke="#9ec5ff" strokeWidth="1.5" /><path d="M32 26 V52" stroke="#9ec5ff" strokeWidth="1.5" /><path d="M32 26 c-8-10-18 0-0 0 c8-10 18 0 0 0" fill="none" stroke="#5aa9ff" strokeWidth="2" /></StoryTile> }
function StoryDawn() { return <StoryTile><circle cx="32" cy="40" r="13" fill="#5aa9ff" opacity="0.9" /><line x1="32" y1="14" x2="32" y2="22" stroke="#5aa9ff" strokeWidth="2" /><line x1="14" y1="40" x2="20" y2="40" stroke="#5aa9ff" strokeWidth="2" /><line x1="44" y1="40" x2="50" y2="40" stroke="#5aa9ff" strokeWidth="2" /><line x1="12" y1="52" x2="52" y2="52" stroke="#9ec5ff" strokeWidth="2" /></StoryTile> }
function StoryTile({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 64 64" style={{ width: "100%", height: "100%", display: "block", background: "linear-gradient(160deg,#1a2440,#0e1426)" }} aria-hidden>
      {children}
    </svg>
  )
}

/* ── Icons ──────────────────────────────────────────────────────────────── */
function IconText() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4h10M3 8h10M3 12h6" strokeLinecap="round" /></svg> }
function IconAudio() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 8v0M5 5v6M8 3v10M11 5.5v5M14 8v0" strokeLinecap="round" /></svg> }
function IconVideo() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="4" width="12" height="8" rx="1.5" /><path d="M7 6.5l3 1.5-3 1.5z" fill="currentColor" stroke="none" /></svg> }
function IconImage() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1.2" /><path d="M3.5 11l3-3 2.5 2 2-2 1.5 1.5" /></svg> }
function IconStory() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3.5C6.5 2.5 4 2.5 2.5 3.2v9c1.5-.7 4-.7 5.5.3M8 3.5c1.5-1 4-1 5.5-.3v9c-1.5-.7-4-.7-5.5.3z" /></svg> }
function IconPlay() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M5 3.5v9l7-4.5z" /></svg> }
function IconPause() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><rect x="4" y="3.5" width="3" height="9" rx="1" /><rect x="9" y="3.5" width="3" height="9" rx="1" /></svg> }
function IconMic() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="6" y="2" width="4" height="8" rx="2" /><path d="M4 8a4 4 0 0 0 8 0M8 12v2" strokeLinecap="round" /></svg> }
function IconSpark() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="15" height="15" fill="currentColor" style={{ color: "var(--aq-gold)" }}><path d="M8 1l1.4 4.2L13.5 6 9.4 7.8 8 12l-1.4-4.2L2.5 6l4.1-.8z" /></svg> }
function IconLock() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3.5" y="7" width="9" height="6" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg> }
function IconCheckTiny() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="#22c55e" strokeWidth="2.4"><path d="M3.5 8.5l2.5 2.5 6-6.5" strokeLinecap="round" strokeLinejoin="round" /></svg> }
function IconAquila() { return <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--aq-gold)" strokeWidth="1.4"><path d="M2 9c2.5-3 5-3 6-1 1-2 3.5-2 6 1-2.5-1-4 0-6 2-2-2-3.5-3-6-2z" strokeLinejoin="round" /></svg> }
