/**
 * Re-fetch the English Kokoro 82M speaker samples we vendor under
 * public/kokoro-previews/. Source WAVs are the public Rewind catalog
 * (https://rewind.ai/voices/); we keep only the 28 ids kokoro-js ships.
 *
 * Requires ffmpeg on PATH.
 */
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KOKORO_BUNDLED_VOICES } from "../src/lib/audio/kokoro-languages"

const OUT_DIR = join(import.meta.dirname, "..", "public", "kokoro-previews")
const UA = "Aquilla kokoro preview fetch (https://aquilla.app)"

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  const rawDir = await mkdtemp(join(tmpdir(), "kokoro-previews-"))
  let ok = 0
  try {
    for (const voice of KOKORO_BUNDLED_VOICES) {
      const url = `https://rewind.ai/static/voice_previews/kokoro-${voice.id}.wav`
      const wav = join(rawDir, `${voice.id}.wav`)
      const mp3 = join(OUT_DIR, `${voice.id}.mp3`)
      const res = await fetch(url, { headers: { "User-Agent": UA } })
      if (!res.ok) {
        throw new Error(`${voice.id}: GET ${url} → ${res.status}`)
      }
      await writeFile(wav, Buffer.from(await res.arrayBuffer()))
      const ffmpeg = spawnSync(
        "ffmpeg",
        ["-y", "-loglevel", "error", "-i", wav, "-codec:a", "libmp3lame", "-b:a", "48k", "-ac", "1", "-ar", "24000", mp3],
        { stdio: "inherit" },
      )
      if (ffmpeg.status !== 0) {
        throw new Error(`${voice.id}: ffmpeg failed (${ffmpeg.status})`)
      }
      ok += 1
      console.log(`ok ${voice.id}`)
    }
  } finally {
    await rm(rawDir, { recursive: true, force: true })
  }
  console.log(`wrote ${ok} previews to ${OUT_DIR}`)
}

await main()
