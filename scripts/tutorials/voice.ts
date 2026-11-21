/**
 * Says each tutorial line once and keeps it. A line's recording is named by
 * its words, so only a changed line is said again, and the take holds each
 * line for exactly as long as its recording lasts
 * (e2e/recordings/tutorials/tutorial.ts reads voice.json).
 *
 * Two voices can say them. Gemini, when GEMINI_API_KEY is set: the model and
 * voice LangQuest's tutorial videos use ("Sulafat"), changed with
 * TUTORIAL_TTS_MODEL and TUTORIAL_TTS_VOICE. Otherwise ElevenLabs, with the two
 * variables scripts/assemble-showcase.ts reads: ELEVENLABS_API_KEY and
 * ELEVENLABS_VOICE_ID. With neither, nothing is said: the videos are filmed at
 * reading speed and published with captions only, marked `voiced: false` in
 * videos.json.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { hashText } from "../../e2e/recordings/tutorials/look"
import type { TutorialDef } from "../../e2e/recordings/tutorials/catalog"
import { mediaMs } from "./compose"

interface Speaker {
  /** Kept in voice.json: another voice or model says every line again. */
  voice: string
  model: string
  extension: "mp3" | "wav"
  /** Say one line into `file`. */
  say(text: string, file: string): Promise<void>
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 16-bit mono PCM, as Gemini returns speech, with a WAV header in front. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const head = Buffer.alloc(44)
  head.write("RIFF", 0)
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write("WAVEfmt ", 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // mono
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(sampleRate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write("data", 36)
  head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

/**
 * What Gemini sends as speech, as a WAV holding the sound and nothing else.
 *
 * It is not always the raw PCM its `audio/L16` label promises: a reply can be
 * a whole WAV file, with a C2PA (content credentials) chunk after the sound.
 * Wrapped in a second header, that file's own header plays as a click before
 * every line and its C2PA chunk as a crackle after it.
 */
export function speechToWav(bytes: Buffer, labelledRate: number): Buffer {
  if (bytes.subarray(0, 4).toString("latin1") !== "RIFF") return pcmToWav(bytes, labelledRate)
  let rate = labelledRate
  let pcm: Buffer | null = null
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = bytes.subarray(at, at + 4).toString("latin1")
    const size = bytes.readUInt32LE(at + 4)
    const body = bytes.subarray(at + 8, at + 8 + size)
    if (id === "fmt ") {
      if (body.readUInt16LE(0) !== 1 || body.readUInt16LE(2) !== 1 || body.readUInt16LE(14) !== 16) {
        throw new Error("Gemini sent a WAV that is not 16-bit mono PCM; speechToWav needs to learn it")
      }
      rate = body.readUInt32LE(4)
    }
    if (id === "data") pcm = body
    at += 8 + size + (size % 2)
  }
  if (!pcm) throw new Error("Gemini sent a WAV with no sound in it")
  return pcmToWav(pcm, rate)
}

function gemini(key: string): Speaker {
  const model = process.env.TUTORIAL_TTS_MODEL ?? "gemini-3.8-flash-tts"
  const voice = process.env.TUTORIAL_TTS_VOICE ?? "Sulafat"
  return {
    voice: `gemini:${voice}`,
    model,
    extension: "wav",
    async say(text, file) {
      // A key without billing gets a few requests a minute and a small number
      // a day; a 429 is waited out six times before the line is given up.
      for (let attempt = 1; ; attempt += 1) {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": key, "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            },
          }),
        })
        if (res.status === 429 && attempt < 6) {
          console.warn(`[tutorials] Gemini's rate limit; waiting 65 s (try ${attempt} of 6). A key with billing on has no such wait.`)
          await pause(65_000)
          continue
        }
        if (!res.ok) throw new Error(`Gemini refused "${text}" (${res.status}): ${(await res.text()).slice(0, 600)}`)
        const reply = (await res.json()) as {
          candidates?: { content?: { parts?: { inlineData?: { data: string; mimeType?: string } }[] } }[]
        }
        const audio = reply.candidates?.[0]?.content?.parts?.[0]?.inlineData
        if (!audio) throw new Error(`Gemini sent no audio for "${text}"`)
        const rate = Number(/rate=(\d+)/.exec(audio.mimeType ?? "")?.[1] ?? 24000)
        const raw = `${file}.raw.wav`
        writeFileSync(raw, speechToWav(Buffer.from(audio.data, "base64"), rate))
        // Gemini leaves quiet before and after what it says. Left in, each
        // line starts late and the take holds longer than the words last. A
        // short fade at each cut, so a line never starts or stops on a click.
        const trim = (keep: string, fade: string): string =>
          `silenceremove=start_periods=1:start_threshold=-45dB:start_silence=${keep},afade=t=in:d=${fade}`
        const run = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-af", `${trim("0.05", "0.008")},areverse,${trim("0.12", "0.03")},areverse`, file], { encoding: "utf8" })
        rmSync(raw, { force: true })
        if (run.status !== 0) throw new Error(`Could not trim the quiet off "${text}": ${run.stderr}`)
        return
      }
    },
  }
}

function elevenLabs(key: string, voice: string): Speaker {
  const model = "eleven_flash_v2_5"
  return {
    voice: `elevenlabs:${voice}`,
    model,
    extension: "mp3",
    async say(text, file) {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: model }),
      })
      if (!res.ok) throw new Error(`ElevenLabs refused "${text}" (${res.status}): ${await res.text()}`)
      writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    },
  }
}

function speaker(): Speaker | null {
  const { GEMINI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID } = process.env
  if (GEMINI_API_KEY) return gemini(GEMINI_API_KEY)
  if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) return elevenLabs(ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID)
  return null
}

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
  const by = speaker()
  if (!by) {
    return { said: 0, kept: 0, skipped: "neither GEMINI_API_KEY nor ELEVENLABS_API_KEY with ELEVENLABS_VOICE_ID is set" }
  }
  mkdirSync(dir, { recursive: true })
  const before = readVoiceIndex(dir)
  const index: VoiceIndex =
    before && before.voice === by.voice && before.model === by.model ? before : { voice: by.voice, model: by.model, lines: {} }
  const todo = unsaidLines(tutorials, index)
  const kept = Object.keys(index.lines).length
  const save = (): void => writeFileSync(path.join(dir, "voice.json"), JSON.stringify(index, null, 2))

  for (const text of todo) {
    const file = `${hashText(text)}.${by.extension}`
    try {
      await by.say(text, path.join(dir, file))
    } catch (error) {
      // What was said so far is kept; the next run says the rest.
      save()
      throw error
    }
    index.lines[hashText(text)] = { file, durationMs: mediaMs(path.join(dir, file)), text }
    save()
  }
  save()
  return { said: todo.length, kept }
}
