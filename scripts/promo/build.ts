/**
 * build — assemble a persona's deterministic promo trailer end to end.
 *
 *   render frames  (compose.html via Chromium, seek-and-shoot)
 *   synth audio    (code-synth PCM score; mood + beats from the persona brief)
 *   mux with ffmpeg → H.264 MP4 (16:9), then a 9:16 social reformat
 *
 * Pick a persona: `tsx scripts/promo/build.ts --persona p5-org-admin`, or
 * PROMO_PERSONA=p5-org-admin. Output files are named per persona.
 *
 * Real app footage is optional: if e2e/recordings/output/promo/app/*.png exist
 * (from `npm run promo:capture`), the composition composites them; otherwise it
 * falls back to a stylized panel so the pipeline always produces something.
 * Everything degrades gracefully: no ffmpeg → frames + wav are still emitted.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadConfig } from "./promo.config"
import { renderFrames } from "./render"
import { renderTrailerAudio, writeWav } from "./synth-audio"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, "../../e2e/recordings/output/promo")

function hasFfmpeg(): boolean {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0
}

/** Read `--persona <slug>` (or `--persona=<slug>`) from argv. */
function personaArg(): string | undefined {
  const a = process.argv.slice(2)
  const i = a.findIndex((x) => x === "--persona")
  if (i >= 0 && a[i + 1]) return a[i + 1]
  const eq = a.find((x) => x.startsWith("--persona="))
  return eq?.split("=")[1]
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const promo = loadConfig(personaArg())
  const slug = promo.persona
  console.log(`[promo:build] persona "${slug}" — ${promo.emotionalThroughline}`)

  // 1) deterministic frames
  const { frameDir, count } = await renderFrames(promo)

  // 2) code-synth score: mood + beats come from the persona brief
  const wav = path.join(OUT, `${slug}.score.wav`)
  writeWav(wav, renderTrailerAudio({ durationSec: promo.durationSec, beats: promo.beats, mood: promo.mood }))
  console.log(`[promo:build] score (${promo.mood}) → ${wav}`)

  if (!hasFfmpeg()) {
    console.warn("[promo:build] ffmpeg not found — emitted frames + score.wav only.")
    return
  }

  // 3) mux frames + audio → 16:9 master
  const mp4 = path.join(OUT, `aquilla-${slug}.mp4`)
  const pattern = path.join(frameDir, "f%05d.png")
  const mux = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-framerate", String(promo.fps),
      "-i", pattern,
      "-i", wav,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-r", String(promo.fps),
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart",
      mp4,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  if (mux.status !== 0) {
    console.warn("[promo:build] ffmpeg mux failed; frames + score.wav remain usable.")
    return
  }
  console.log(`[promo:build] 16:9 → ${mp4}  (${count} frames, ${promo.durationSec}s)`)

  // 4) 9:16 social reformat (center-crop + blurred pillars to fill)
  const vert = path.join(OUT, `aquilla-${slug}-9x16.mp4`)
  const vfilter =
    "split[a][b];[b]scale=1080:1920,boxblur=40:8[bg];" +
    "[a]scale=1080:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,crop=1080:1920"
  const reformat = spawnSync(
    "ffmpeg",
    ["-y", "-i", mp4, "-vf", vfilter, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", vert],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  if (reformat.status === 0) console.log(`[promo:build] 9:16 → ${vert}`)
  else console.warn("[promo:build] 9:16 reformat failed (16:9 master is still good).")

  console.log("[promo:build] done. Route through the human gate before publishing (docs/distribution/DISTRIBUTION-CYCLE.md).")
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
