/**
 * Says each tutorial line once and keeps it. A line's recording is named by
 * its words, so only a changed line is said again, and the take holds each
 * line for exactly as long as its recording lasts
 * (e2e/recordings/tutorials/tutorial.ts reads voice.json).
 *
 * The voice is ElevenLabs, with the same two variables scripts/assemble-showcase.ts
 * reads: ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID. Without them nothing is
 * said: the videos are filmed at reading speed and published with captions
 * only, marked `voiced: false` in videos.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { hashText } from "../../e2e/recordings/tutorials/look"
import type { TutorialDef } from "../../e2e/recordings/tutorials/catalog"
import { mediaMs } from "./compose"

const MODEL = "eleven_flash_v2_5"

export interface VoiceIndex {
  /** The voice and model the lines were said with: another voice says them all again. */
  voice: string
  model: string
  lines: Record<string, { file: string; durationMs: number; text: string }>
}

export function readVoiceIndex(dir: string): VoiceIndex | null {
  const file = path.join(dir, "voice.json")
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as VoiceIndex) : null
}

/** Every line of the given tutorials that the index does not hold yet. */
export function unsaidLines(tutorials: readonly TutorialDef[], index: VoiceIndex | null): string[] {
  const texts = new Set(tutorials.flatMap((tutorial) => Object.values(tutorial.lines)))
  return [...texts].filter((text) => !index?.lines[hashText(text)])
}

export interface VoiceResult {
  said: number
  kept: number
  /** Why nothing was said, when nothing could be. */
  skipped?: string
}

export async function makeVoice(tutorials: readonly TutorialDef[], dir: string): Promise<VoiceResult> {
  const key = process.env.ELEVENLABS_API_KEY
  const voice = process.env.ELEVENLABS_VOICE_ID
  if (!key || !voice) {
    return { said: 0, kept: 0, skipped: "ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are not set" }
  }
  mkdirSync(dir, { recursive: true })
  const before = readVoiceIndex(dir)
  const index: VoiceIndex =
    before && before.voice === voice && before.model === MODEL ? before : { voice, model: MODEL, lines: {} }
  const todo = unsaidLines(tutorials, index)
  const kept = Object.keys(index.lines).length

  for (const text of todo) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: MODEL }),
    })
    if (!res.ok) {
      // What was said so far is kept; the run says the rest next time.
      writeFileSync(path.join(dir, "voice.json"), JSON.stringify(index, null, 2))
      throw new Error(`ElevenLabs refused "${text}" (${res.status}): ${await res.text()}`)
    }
    const file = `${hashText(text)}.mp3`
    writeFileSync(path.join(dir, file), Buffer.from(await res.arrayBuffer()))
    index.lines[hashText(text)] = { file, durationMs: mediaMs(path.join(dir, file)), text }
  }
  writeFileSync(path.join(dir, "voice.json"), JSON.stringify(index, null, 2))
  return { said: todo.length, kept }
}
