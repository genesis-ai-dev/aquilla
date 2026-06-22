/**
 * assemble-showcase — turn a raw showcase recording + its storyboard into
 * distribution-ready inputs: a clean MP4, an edit-list (title cards + caption
 * timings), an optional ElevenLabs voiceover track, and a per-channel cut
 * manifest (announce / docs / market).
 *
 * This is the deterministic render integration point of the distribution
 * cycle. It does the parts that must be reproducible; the final composited
 * video (title cards, lower-thirds, brand intro/outro) is produced by the
 * HyperFrames/Remotion step which consumes the edit-list this emits.
 *
 *   tsx scripts/assemble-showcase.ts [--slug p1-field-translator__local-first-editing]
 *                                    [--video path/to/video.webm]
 *                                    [--vo]            # synth ElevenLabs VO from captions
 *
 * Everything degrades gracefully: no ffmpeg → emits edit-list + cuts only and
 * tells you what to install; no ELEVENLABS_API_KEY → skips VO with a note.
 * It never fabricates a video it didn't actually transcode.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const OUT = path.join(REPO_ROOT, "e2e/recordings/output")

interface Storyboard {
  slug: string
  persona: string
  feature: string
  title: string
  cta: string
  durationMs: number
  chapters: { t: number; title: string; subtitle?: string }[]
  captions: { t: number; text: string }[]
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function has(flag: string): boolean {
  return process.argv.includes(flag)
}

function hasFfmpeg(): boolean {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0
}

/** Recursively collect files matching a predicate. */
function walk(dir: string, pred: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, pred))
    else if (pred(full)) out.push(full)
  }
  return out
}

function newestBy<T>(items: T[], key: (t: T) => number): T | undefined {
  return items.slice().sort((a, b) => key(b) - key(a))[0]
}

function findStoryboard(slug?: string): Storyboard {
  const files = walk(OUT, (f) => f.endsWith(".storyboard.json"))
  if (files.length === 0) {
    throw new Error(`No storyboards in ${OUT}. Run \`npm run record\` first.`)
  }
  const chosen = slug
    ? files.find((f) => path.basename(f) === `${slug}.storyboard.json`)
    : newestBy(files, (f) => statSync(f).mtimeMs)
  if (!chosen) throw new Error(`No storyboard for slug "${slug}". Found: ${files.map((f) => path.basename(f)).join(", ")}`)
  return JSON.parse(readFileSync(chosen, "utf-8")) as Storyboard
}

/** Playwright writes video.webm under outputDir/<test-folder>/. Pair by recency. */
function findVideo(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined
  const vids = walk(OUT, (f) => f.endsWith(".webm"))
  return newestBy(vids, (f) => statSync(f).mtimeMs)
}

/** Per-channel cut recommendations, derived from chapter marks. */
function buildCuts(sb: Storyboard) {
  const end = sb.durationMs
  return {
    announce: {
      // Short social clip: open + the money-moment chapter + CTA tail.
      target: "social (Bluesky/Mastodon/X), ~20-30s",
      in: 0,
      out: Math.min(end, 30_000),
      caption: sb.title,
    },
    docs: {
      target: "docs embed / changelog, full walkthrough",
      in: 0,
      out: end,
      caption: `${sb.persona}: ${sb.feature}`,
    },
    market: {
      target: "landing hero / Product Hunt, ~45-60s",
      in: 0,
      out: Math.min(end, 60_000),
      caption: sb.cta,
    },
  }
}

async function synthVoiceover(sb: Storyboard, outPath: string): Promise<boolean> {
  const key = process.env.ELEVENLABS_API_KEY
  const voice = process.env.ELEVENLABS_VOICE_ID
  if (!key || !voice) {
    console.warn("[assemble] --vo requested but ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set; skipping VO.")
    return false
  }
  const script = sb.captions.map((c) => c.text).join(" ")
  if (!script.trim()) {
    console.warn("[assemble] no captions to narrate; skipping VO.")
    return false
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text: script, model_id: "eleven_flash_v2_5" }),
  })
  if (!res.ok) {
    console.warn(`[assemble] ElevenLabs ${res.status}: ${await res.text()}; skipping VO.`)
    return false
  }
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(outPath, buf)
  console.log(`[assemble] VO → ${path.relative(REPO_ROOT, outPath)} (${(buf.length / 1024).toFixed(0)} KB)`)
  return true
}

async function main(): Promise<void> {
  const sb = findStoryboard(arg("--slug"))
  console.log(`[assemble] storyboard: ${sb.slug}  (${sb.chapters.length} chapters, ${sb.captions.length} captions, ${(sb.durationMs / 1000).toFixed(1)}s)`)

  const editlist = {
    slug: sb.slug,
    title: sb.title,
    cta: sb.cta,
    persona: sb.persona,
    feature: sb.feature,
    titleCards: sb.chapters.map((c) => ({ atMs: c.t, headline: c.title, sub: c.subtitle ?? "" })),
    voScript: sb.captions.map((c) => ({ atMs: c.t, line: c.text })),
    cuts: buildCuts(sb),
  }
  const editlistPath = path.join(OUT, `${sb.slug}.editlist.json`)
  writeFileSync(editlistPath, JSON.stringify(editlist, null, 2))
  console.log(`[assemble] edit-list → ${path.relative(REPO_ROOT, editlistPath)}`)

  if (has("--vo")) {
    await synthVoiceover(sb, path.join(OUT, `${sb.slug}.vo.mp3`))
  }

  const video = findVideo(arg("--video"))
  if (!video) {
    console.warn(`[assemble] no .webm recording found under ${OUT}. Edit-list + cuts emitted; record first to produce the MP4.`)
    return
  }
  console.log(`[assemble] recording: ${path.relative(REPO_ROOT, video)}`)

  if (!hasFfmpeg()) {
    console.warn("[assemble] ffmpeg not found — skipping transcode. Install ffmpeg, then re-run, or feed the .webm + edit-list to the HyperFrames/Remotion step.")
    return
  }
  const mp4 = path.join(OUT, `${sb.slug}.mp4`)
  // Normalise to a clean, faststart 30fps H.264 MP4 the assembler/social
  // platforms accept; captions are already burned into the frame by Showcase.
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", video, "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4],
    { stdio: "inherit" },
  )
  if (r.status !== 0) {
    console.warn("[assemble] ffmpeg transcode failed; the raw .webm and edit-list are still usable.")
    return
  }
  console.log(`[assemble] MP4 → ${path.relative(REPO_ROOT, mp4)}`)
  console.log("[assemble] done. Next: feed the edit-list + MP4 to the HyperFrames/Remotion composition for branded title cards + intro/outro, then route cuts through the human gate (see docs/distribution/DISTRIBUTION-CYCLE.md).")
}

main().catch((e) => {
  console.error("[assemble] fatal:", e)
  process.exit(1)
})
