/**
 * build — assemble the deterministic promo trailer end to end.
 *
 *   render frames  (compose.html via Chromium, seek-and-shoot)
 *   synth audio    (code-synth PCM score, beats aligned to promo.config)
 *   mux with ffmpeg → H.264 MP4 (16:9), then a 9:16 social reformat
 *
 * Real app footage is optional: if e2e/recordings/output/promo/app/*.png exist
 * (from `npm run promo:capture`), the composition composites them; otherwise it
 * falls back to a stylized panel so the pipeline always produces something.
 *
 * Everything degrades gracefully: no ffmpeg → frames + wav are still emitted.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { PROMO } from "./promo.config"
import { renderFrames } from "./render"
import { renderTrailerAudio, writeWav } from "./synth-audio"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, "../../e2e/recordings/output/promo")

function hasFfmpeg(): boolean {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0
}

async function main() {
  mkdirSync(OUT, { recursive: true })

  // 1) deterministic frames
  const { frameDir, count } = await renderFrames()

  // 2) code-synth score on the shared beat grid
  const wav = path.join(OUT, "score.wav")
  writeWav(wav, renderTrailerAudio({ durationSec: PROMO.durationSec, beats: PROMO.beats }))
  console.log(`[promo:build] score → ${wav}`)

  if (!hasFfmpeg()) {
    console.warn("[promo:build] ffmpeg not found — emitted frames + score.wav only.")
    return
  }

  // 3) mux frames + audio → 16:9 master
  const mp4 = path.join(OUT, "aquilla-trailer.mp4")
  const pattern = path.join(frameDir, "f%05d.png")
  const mux = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-framerate", String(PROMO.fps),
      "-i", pattern,
      "-i", wav,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-r", String(PROMO.fps),
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
  console.log(`[promo:build] 16:9 → ${mp4}  (${count} frames, ${PROMO.durationSec}s)`)

  // 4) 9:16 social reformat (center-crop + blurred pillars to fill)
  const vert = path.join(OUT, "aquilla-trailer-9x16.mp4")
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
