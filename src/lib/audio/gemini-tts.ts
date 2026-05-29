import type { Voice } from "@/lib/parsers/types"
import { pcm16BytesToWavBlob } from "./wav"
import { DEFAULT_PROMPT_TEMPLATE } from "./voices"

export const GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview"
export { DEFAULT_TTS_PROVIDER, GEMINI_TTS_VOICES } from "./tts-providers"

export interface GeminiTtsContext {
  sourceLanguage?: string
  targetLanguage?: string
  original?: string
  cellLabel?: string
  context?: string
}

interface GeminiTtsResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: {
          data?: string
          mimeType?: string
        }
      }>
    }
  }>
  error?: { message?: string }
}

/**
 * Substitute {placeholders} in a prompt template against the cell context
 * + voice metadata.
 *
 * The character creator collapses Accent / Pronunciation / Prompt into a single
 * free-text "Guidance" field, stored on `voice.prompt`. Guidance is usually
 * plain prose with no {placeholders} (e.g. "calm, warm, elderly; coastal
 * Swahili reading"). When the template carries no {text} slot we treat it as
 * that guidance and wrap it in protective framing so Gemini speaks the line —
 * not the guidance — at the requested character. Full templates that DO include
 * {text} (the built-in presets) are rendered inline and left otherwise as-is,
 * so {accent}/{pronunciationReference} still work for legacy voices.
 */
export function buildGeminiTtsPrompt(
  text: string,
  template: string,
  ctx: GeminiTtsContext = {},
  voice?: Pick<Voice, "accent" | "pronunciationReference">,
): string {
  const values: Record<string, string> = {
    text,
    source: ctx.sourceLanguage || "",
    target: ctx.targetLanguage || "",
    original: ctx.original || "",
    cellLabel: ctx.cellLabel || "",
    context: ctx.context || "",
    accent: voice?.accent || "the target community's natural reading accent",
    pronunciationReference:
      voice?.pronunciationReference ||
      "the closest high-resource language whose pronunciation matches this orthography",
  }
  const rendered = template.replace(
    /\{(text|source|target|original|cellLabel|context|accent|pronunciationReference)\}/g,
    (_match, key: string) => values[key] ?? "",
  ).trim()
  if (template.includes("{text}")) return rendered

  // Plain guidance: instruction first, then the line to read, clearly fenced so
  // the guidance itself is never spoken.
  const language = values.target ? ` ${values.target}` : ""
  const guidance = rendered ? `Voice direction: ${rendered}\n` : ""
  return [
    `Read the following${language} text aloud for an audio Scripture recording.`,
    guidance + "Do not add any words that are not in the text. Read only the text below.",
    "",
    text,
  ].join("\n").trim()
}

export async function synthesizeGeminiTtsToWavBlob(args: {
  text: string
  apiKey: string
  voice: Voice
  context?: GeminiTtsContext
}): Promise<Blob> {
  const apiKey = args.apiKey.trim()
  if (!apiKey) throw new Error("Add a Gemini API key in Project Settings before using Gemini voice generation.")
  const model = args.voice.model?.trim() || GEMINI_TTS_MODEL
  const voiceName = args.voice.voiceName?.trim() || "Kore"
  const template = args.voice.prompt?.trim() || DEFAULT_PROMPT_TEMPLATE
  const prompt = buildGeminiTtsPrompt(args.text, template, args.context, args.voice)

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelPath(model)}:generateContent`
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
      },
      model,
    }),
  })

  const json = await readJson(res)
  if (!res.ok) {
    throw new Error(`Gemini TTS failed (${res.status}): ${json.error?.message || res.statusText}`)
  }

  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
  const data = part?.inlineData?.data
  if (!data) throw new Error("Gemini TTS response did not include audio data.")
  const pcm = base64ToUint8Array(data)
  return pcm16BytesToWavBlob(pcm, sampleRateFromMimeType(part?.inlineData?.mimeType))
}

async function readJson(res: Response): Promise<GeminiTtsResponse> {
  try {
    return (await res.json()) as GeminiTtsResponse
  } catch {
    return {}
  }
}

export function sampleRateFromMimeType(mimeType: string | undefined): number {
  const match = mimeType?.match(/rate=(\d+)/i)
  return match ? Number(match[1]) : 24000
}

export function base64ToUint8Array(data: string): Uint8Array {
  const binary = globalThis.atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function modelPath(model: string): string {
  return encodeURIComponent(model.trim().replace(/^models\//, ""))
}
