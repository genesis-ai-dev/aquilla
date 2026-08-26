/**
 * Encode WAV speaker samples into public/kokoro-previews/*.mp3.
 *
 * Recursively finds `{id}.wav` in the directories you pass (flat English
 * pack, language-folder multilingual pack, or both).
 *
 *   npx tsx scripts/fetch-kokoro-previews.ts /path/to/wavs
 *
 * Requires ffmpeg on PATH.
 */
import { spawnSync } from "node:child_process"
import { mkdir, readdir, stat } from "node:fs/promises"
import { join, parse } from "node:path"

const OUT_DIR = join(import.meta.dirname, "..", "public", "kokoro-previews")

async function collectWavs(root: string, found: Map<string, string>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await collectWavs(path, found)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".wav")) continue
    found.set(parse(entry.name).name, path)
  }
}

async function main(): Promise<void> {
  const roots = process.argv.slice(2)
  if (roots.length === 0) {
    throw new Error("pass one or more directories of Kokoro WAV samples")
  }
  for (const root of roots) {
    const info = await stat(root)
    if (!info.isDirectory()) {
      throw new Error(`${root} is not a directory`)
    }
  }

  const wavs = new Map<string, string>()
  for (const root of roots) await collectWavs(root, wavs)
  const ids = [...wavs.keys()].sort()
  if (ids.length === 0) {
    throw new Error("no .wav files found")
  }

  await mkdir(OUT_DIR, { recursive: true })
  let ok = 0
  for (const id of ids) {
    const wav = wavs.get(id)!
    const mp3 = join(OUT_DIR, `${id}.mp3`)
    const ffmpeg = spawnSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", wav, "-codec:a", "libmp3lame", "-b:a", "48k", "-ac", "1", "-ar", "24000", mp3],
      { stdio: "inherit" },
    )
    if (ffmpeg.status !== 0) {
      throw new Error(`${id}: ffmpeg failed (${ffmpeg.status})`)
    }
    ok += 1
    console.log(`ok ${id}`)
  }
  console.log(`wrote ${ok} previews to ${OUT_DIR}`)
}

await main()
