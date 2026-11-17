/**
 * The tutorial videos, end to end (docs/TUTORIAL-VIDEOS.md):
 *
 *   pnpm tutorials                       say, film, put together; publish nothing
 *   pnpm tutorials --only translate-a-verse,validate-a-verse
 *   pnpm tutorials --skip-film           put together the takes already filmed
 *   pnpm tutorials --publish             and upload what changed, with videos.json
 *
 * Steps: voice (scripts/tutorials/voice.ts) → film (`pnpm record`, the
 * Showcase harness) → compose (cards.ts, compose.ts) → plan against the
 * videos.json that is up (manifest.ts) → publish (wrangler r2).
 *
 * Nothing is uploaded without --publish, and a video whose take failed or was
 * not verified is left out: the film that is up stays up.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TUTORIALS, type TutorialDef } from "../../e2e/recordings/tutorials/catalog"
import { hashText } from "../../e2e/recordings/tutorials/look"
import { FRAME } from "./brand"
import { drawCards } from "./cards"
import { compose, totalMs, type Take, type TakeLine, type VoiceFiles } from "./compose"
import { plan, type Filmed, type VideoManifest } from "./manifest"
import { makeVoice, readVoiceIndex } from "./voice"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const OUT = path.join(REPO_ROOT, "e2e/recordings/output")
// Not under OUT: Playwright empties its output folder at the start of every
// run, which would take the voice (made before filming) and the other videos'
// files with it. `.video-staging/` is git-ignored, as the walkthroughs use it.
const WORK = path.join(REPO_ROOT, ".video-staging/tutorials")
const VOICE_DIR = path.join(WORK, "voice")
const PUBLISH_DIR = path.join(WORK, "publish")

/** Where the videos are served, and the R2 bucket and prefix behind that
 * address. docs.aquilla.app/media/<key> serves aquilla-docs/walkthroughs/<key>
 * (docs/walkthroughs/UPLOAD-MANIFEST.tsv); override when that changes. */
const PUBLIC_BASE = process.env.TUTORIALS_PUBLIC_BASE ?? "https://docs.aquilla.app/media/tutorials"
const R2_PREFIX = process.env.TUTORIALS_R2_PREFIX ?? "aquilla-docs/walkthroughs/tutorials"
const LANGUAGE = "en"

const flag = (name: string): boolean => process.argv.includes(name)
function option(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

interface Storyboard {
  verified: boolean
  durationMs: number
  tutorial?: {
    id: string
    preludeMs: number
    video: string | null
    lines: TakeLine[]
    look: string
    voiced: boolean
  }
}

function chosen(): TutorialDef[] {
  const only = option("--only")?.split(",").map((id) => id.trim()).filter(Boolean)
  if (!only) return [...TUTORIALS]
  const unknown = only.filter((id) => !TUTORIALS.some((tutorial) => tutorial.id === id))
  if (unknown.length > 0) throw new Error(`No tutorial named ${unknown.join(", ")}`)
  return TUTORIALS.filter((tutorial) => only.includes(tutorial.id))
}

/** A video's script: its lines and its spec, hashed. A reworded line or a
 * changed step publishes the video again even when no screen reads differently. */
function scriptOf(tutorial: TutorialDef): string {
  const spec = readFileSync(path.join(REPO_ROOT, "e2e/recordings/specs/tutorials", `${tutorial.id}.showcase.ts`), "utf-8")
  return hashText(JSON.stringify(tutorial.lines) + spec)
}

function film(tutorials: TutorialDef[]): boolean {
  const titles = tutorials.map((tutorial) => tutorial.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  const run = spawnSync("pnpm", ["run", "record", "-g", `Tutorial · (${titles})$`], { cwd: REPO_ROOT, stdio: "inherit" })
  return run.status === 0
}

function readStoryboard(id: string): Storyboard | null {
  const file = path.join(OUT, `tutorial__${id}.storyboard.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Storyboard) : null
}

async function previousManifest(): Promise<VideoManifest | null> {
  const from = option("--previous") ?? `${PUBLIC_BASE}/videos.json`
  if (!/^https?:/.test(from)) return existsSync(from) ? (JSON.parse(readFileSync(from, "utf-8")) as VideoManifest) : null
  const res = await fetch(from).catch(() => null)
  // None up yet (the first run), or the address is not serving: publish every video.
  if (!res || !res.ok) return null
  return (await res.json()) as VideoManifest
}

function upload(file: string, key: string, contentType: string): void {
  const run = spawnSync(
    "pnpm",
    ["exec", "wrangler", "r2", "object", "put", `${R2_PREFIX}/${key}`, `--file=${file}`, `--content-type=${contentType}`, "--remote"],
    { cwd: REPO_ROOT, stdio: "inherit" },
  )
  if (run.status !== 0) throw new Error(`Could not upload ${key}. Is CLOUDFLARE_API_TOKEN set, with write access to the bucket?`)
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

async function main(): Promise<void> {
  const tutorials = chosen()
  mkdirSync(PUBLISH_DIR, { recursive: true })
  const problems: string[] = []

  const voice = await makeVoice(tutorials, VOICE_DIR)
  console.log(
    voice.skipped
      ? `[tutorials] no voice: ${voice.skipped}. Filming at reading speed, captions only.`
      : `[tutorials] voice: ${voice.said} lines said, ${voice.kept} kept.`,
  )

  if (!flag("--skip-film") && !film(tutorials)) {
    problems.push("a take failed (see the recording's output above)")
  }

  const index = readVoiceIndex(VOICE_DIR)
  const filmed: Filmed[] = []
  for (const tutorial of tutorials) {
    const board = readStoryboard(tutorial.id)
    const shot = board?.tutorial
    if (!board || !shot || !board.verified || !shot.video) {
      problems.push(`${tutorial.id}: no verified take, so the film that is up stays up`)
      continue
    }
    const take: Take = {
      id: tutorial.id,
      video: path.join(OUT, shot.video),
      preludeMs: shot.preludeMs,
      durationMs: board.durationMs,
      lines: shot.lines,
    }
    const voiceFiles: VoiceFiles = {}
    for (const line of shot.lines) {
      const said = index?.lines[hashText(line.text)]
      if (line.voiced && said) voiceFiles[line.key] = path.join(VOICE_DIR, said.file)
    }
    const dir = path.join(PUBLISH_DIR, tutorial.id)
    mkdirSync(dir, { recursive: true })
    const cards = await drawCards(REPO_ROOT, WORK, tutorial.id, tutorial.title)
    const made = compose(take, cards, voiceFiles, path.join(dir, tutorial.id))
    console.log(`[tutorials] ${tutorial.id}: ${path.relative(REPO_ROOT, made.mp4)} (${(totalMs(take) / 1000).toFixed(1)}s${shot.voiced ? "" : ", no voice"})`)
    filmed.push({
      id: tutorial.id,
      title: tutorial.title,
      description: Object.values(tutorial.lines)[0],
      audience: tutorial.audience,
      language: LANGUAGE,
      durationSeconds: Math.round(totalMs(take) / 1000),
      voiced: shot.voiced,
      look: shot.look,
      script: scriptOf(tutorial),
      frame: FRAME,
    })
  }

  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim()
  const next = plan(await previousManifest(), filmed, { at: new Date().toISOString(), commit, base: PUBLIC_BASE })
  const manifestFile = path.join(PUBLISH_DIR, "videos.json")
  writeFileSync(manifestFile, JSON.stringify(next.manifest, null, 2) + "\n")

  for (const { id, why } of next.publish) console.log(`[tutorials] to publish: ${id} (${why})`)
  if (next.publish.length === 0) console.log("[tutorials] nothing to publish: every film that is up still stands.")

  if (flag("--publish") && next.publish.length > 0) {
    for (const { id } of next.publish) {
      const base = path.join(PUBLISH_DIR, id, id)
      upload(`${base}.mp4`, `${id}/${id}.mp4`, "video/mp4")
      upload(`${base}.jpg`, `${id}/${id}.jpg`, "image/jpeg")
      upload(`${base}.${LANGUAGE}.vtt`, `${id}/${id}.${LANGUAGE}.vtt`, "text/vtt; charset=utf-8")
      console.log(`[tutorials] published ${id} (sha256 ${sha256(`${base}.mp4`).slice(0, 12)})`)
    }
    // Last, so a page never reads of a film that is not up yet.
    upload(manifestFile, "videos.json", "application/json; charset=utf-8")
    console.log(`[tutorials] ${PUBLIC_BASE}/videos.json`)
  } else if (!flag("--publish")) {
    console.log(`[tutorials] not uploaded (no --publish). Everything is in ${path.relative(REPO_ROOT, PUBLISH_DIR)}/`)
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`[tutorials] ✘ ${problem}`)
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error("[tutorials] fatal:", error)
  process.exit(1)
})
