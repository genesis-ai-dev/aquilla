/**
 * montage — assemble the agentic "expert-in-the-lead" promo.
 *
 * A montage (the record-promo-video skill's "clips" pattern): real walkthrough
 * footage of the wow moments (recorded by
 * e2e/recordings/specs/agentic-promo.showcase.ts) intercut with deterministic
 * kinetic-type cards (scripts/promo/agentic-compose.html) — the pain hook, the
 * HITL→XITL crossout, an animated 83%→100% progress fill, "multimodal by
 * design", and the CTA — under a rights-clean synth score.
 *
 *   render cards   (agentic-compose.html via Chromium, seek-and-shoot → mp4)
 *   trim clips     (from the walkthrough .webm at storyboard chapter windows,
 *                   pillar-boxed onto a blurred 1920×1080 bg so captions stay)
 *   concat + score (ffmpeg concat demuxer + code-synth PCM) → 16:9 master
 *   reformat       → 9:16 social cut
 *
 * Run:  tsx scripts/promo/montage.ts
 * Everything is deterministic; output lands in e2e/recordings/output/promo/.
 */
import { chromium } from "@playwright/test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { renderTrailerAudio, writeWav } from "./synth-audio"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, "../..")
const REC_OUT = path.join(REPO, "e2e/recordings/output")
const OUT = path.join(REC_OUT, "promo")
const WORK = path.join(OUT, "montage-work")
const COMPOSE = path.join(__dirname, "agentic-compose.html")
const STORYBOARD = path.join(REC_OUT, "agentic__expert-in-the-lead.storyboard.json")

const W = 1920, H = 1080, FPS = 30, BRAND = "AQUILLA"

function ffmpeg(args: string[], label: string): void {
  const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  })
  if (r.status !== 0) throw new Error(`ffmpeg failed (${label})`)
}

/** Newest walkthrough take video for the agentic showcase. */
function findWalkthrough(): string {
  const dirs = readdirSync(REC_OUT)
    .filter((d) => d.startsWith("agentic-promo.showcase.ts") && d.includes("chromium"))
    .map((d) => path.join(REC_OUT, d, "video.webm"))
    .filter((p) => existsSync(p))
  if (!dirs.length) throw new Error("no agentic walkthrough video.webm — run `npm run record -- -g \"Agentic hero\"` first")
  return dirs.map((p) => ({ p, m: Number(readFileSync(p).length) })).sort((a, b) => b.m - a.m)[0].p // largest = full take
}

type CardSpec = Record<string, unknown> & { kind: string; dur: number }
type Seg =
  | { kind: "card"; card: CardSpec; dur: number }
  | { kind: "clip"; start: number; dur: number }

/** chapter start time (seconds) by title, from the recorded storyboard. */
function chapter(sb: { chapters: { t: number; title: string }[] }, title: string): number {
  const c = sb.chapters.find((c) => c.title === title)
  if (!c) throw new Error(`storyboard chapter not found: ${title}`)
  return c.t / 1000
}

async function renderCard(browser: import("@playwright/test").Browser, card: CardSpec, framesDir: string): Promise<number> {
  mkdirSync(framesDir, { recursive: true })
  for (const f of readdirSync(framesDir)) rmSync(path.join(framesDir, f))
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await page.addInitScript((c) => { (globalThis as unknown as { __CARD: unknown }).__CARD = c }, { ...card, width: W, height: H, fps: FPS, brand: BRAND })
  await page.goto(pathToFileURL(COMPOSE).href)
  await page.waitForFunction(() => (globalThis as unknown as { __ready?: boolean }).__ready === true)
  const total = Math.round(card.dur * FPS)
  for (let i = 0; i < total; i++) {
    await page.evaluate((tt) => (globalThis as unknown as { __seek: (t: number) => void }).__seek(tt), i / FPS)
    await page.screenshot({ path: path.join(framesDir, `f${String(i).padStart(5, "0")}.png`), clip: { x: 0, y: 0, width: W, height: H } })
  }
  await page.close()
  return total
}

// Snappy cuts: every segment fades IN quickly (hides the incoming first-frame
// flash) but does NOT fade to black — so there are no dark dips between cuts.
// Only the very last segment fades out to black to end the film.
function encodeCardSegment(framesDir: string, dur: number, out: string, last: boolean): void {
  const fadeOut = last ? `,fade=t=out:st=${Math.max(0, dur - 0.5).toFixed(2)}:d=0.5` : ""
  ffmpeg([
    "-framerate", String(FPS), "-i", path.join(framesDir, "f%05d.png"),
    "-vf", `fps=${FPS},format=yuv420p,fade=t=in:st=0:d=0.18${fadeOut},setsar=1`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", String(FPS), out,
  ], `card ${out}`)
}

function encodeClipSegment(src: string, start: number, dur: number, out: string): void {
  // Pillar-box the 1280×800 take onto a blurred fill so the full frame
  // (including burned-in captions at the bottom) is preserved on a 16:9 canvas.
  const vf =
    `[0:v]split=2[bg][fg];` +
    `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:5,eq=brightness=-0.18:saturation=0.9[bgb];` +
    `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs];` +
    `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,fps=${FPS},format=yuv420p,` +
    `fade=t=in:st=0:d=0.18,setsar=1[v]`
  ffmpeg([
    "-ss", start.toFixed(2), "-t", dur.toFixed(2), "-i", src,
    "-filter_complex", vf, "-map", "[v]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", String(FPS), out,
  ], `clip ${out}`)
}

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true })
  const walk = findWalkthrough()
  const sb = JSON.parse(readFileSync(STORYBOARD, "utf8"))
  console.log(`[montage] walkthrough: ${path.relative(REPO, walk)}`)

  // ── the edit list — hook · crossout · agent · progress · rules · terms · multimodal · cta ──
  const segs: Seg[] = [
    { kind: "card", dur: 3.4, card: { kind: "hook", dur: 3.4, title: "The backlog never sleeps.", subtitle: "Thousands of verses. Never enough hands." } },
    { kind: "card", dur: 4.3, card: { kind: "crossout", dur: 4.3, kicker: "Rethink the loop", old: "Human in the loop", new: "Expert in the lead" } },
    { kind: "clip", start: chapter(sb, "Meet the agent") + 0.2, dur: 6.2 },
    { kind: "card", dur: 3.6, card: { kind: "progress", dur: 3.6, from: 83, to: 100, label: "The agent drafts. You approve." } },
    { kind: "clip", start: chapter(sb, "Rules everyone shares") + 1.5, dur: 3.6 },
    { kind: "clip", start: chapter(sb, "One shared vocabulary") + 0.9, dur: 5.0 },
    { kind: "card", dur: 3.8, card: { kind: "multimodal", dur: 3.8, title: "Multimodal by design" } },
    { kind: "card", dur: 3.8, card: { kind: "cta", dur: 3.8, word: "Aquilla", tag: "Expert in the lead" } },
  ]

  // 1) render every segment to a normalized 1920×1080@30 mp4
  const browser = await chromium.launch()
  const segFiles: string[] = []
  const starts: number[] = []
  let clock = 0
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const out = path.join(WORK, `seg${String(i).padStart(2, "0")}.mp4`)
    starts.push(clock)
    if (seg.kind === "card") {
      const framesDir = path.join(WORK, `frames${i}`)
      await renderCard(browser, seg.card, framesDir)
      encodeCardSegment(framesDir, seg.dur, out, i === segs.length - 1)
      console.log(`[montage] card  ${seg.card.kind.padEnd(11)} → ${path.basename(out)} (${seg.dur}s)`)
    } else {
      encodeClipSegment(walk, seg.start, seg.dur, out)
      console.log(`[montage] clip  @${seg.start.toFixed(1)}s          → ${path.basename(out)} (${seg.dur}s)`)
    }
    segFiles.push(out)
    clock += seg.dur
  }
  await browser.close()
  const totalDur = clock

  // 2) concat (re-encode so timebases are uniform)
  const listFile = path.join(WORK, "concat.txt")
  writeFileSync(listFile, segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n")
  const silent = path.join(WORK, "montage-silent.mp4")
  ffmpeg([
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS), silent,
  ], "concat")

  // 3) code-synth score: a thump on each cut, a swell on the crossout + progress, an impact on the CTA
  const beats = starts.map((t, i) => ({
    t: Math.max(0.1, t + 0.05),
    kind: (segs[i].kind === "card" && (segs[i] as { card: CardSpec }).card.kind === "cta")
      ? "impact"
      : (segs[i].kind === "card" && ["crossout", "progress"].includes((segs[i] as { card: CardSpec }).card.kind))
        ? "swell"
        : "thump",
  })) as { t: number; kind: "thump" | "swell" | "impact" }[]
  const wav = path.join(WORK, "score.wav")
  writeWav(wav, renderTrailerAudio({ durationSec: totalDur, beats, mood: "build" }))

  // 4) mux → 16:9 master
  const master = path.join(OUT, "aquilla-agentic-xitl.mp4")
  ffmpeg([
    "-i", silent, "-i", wav,
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", master,
  ], "mux master")
  console.log(`[montage] 16:9 master → ${path.relative(REPO, master)}  (${totalDur.toFixed(1)}s)`)

  // 5) 9:16 social reformat (center scale + blurred pillars)
  const vert = path.join(OUT, "aquilla-agentic-xitl-9x16.mp4")
  const vfilter =
    "split[a][b];[b]scale=1080:1920,boxblur=40:8[bg];" +
    "[a]scale=1080:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,crop=1080:1920"
  ffmpeg([
    "-i", master, "-vf", vfilter, "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", vert,
  ], "reformat 9x16")
  console.log(`[montage] 9:16 social → ${path.relative(REPO, vert)}`)
  console.log("[montage] done. Route through the human gate before publishing.")
}

main().catch((e) => { console.error(e); process.exit(1) })
