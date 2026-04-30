import type { Voice } from "@/lib/parsers/types"
import { pcm16BytesToWavBlob } from "./wav"
import { DEFAULT_PROMPT_TEMPLATE } from "./voices"

export const DEFAULT_TTS_PROVIDER = "gemini" as const
export const GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview"

/** Gemini's prebuilt voice catalog — used to populate the voice picker. */
export const GEMINI_TTS_VOICES: readonly { name: string; description: string }[] = [
  { name: "Zephyr", description: "Bright" },
  { name: "Puck", description: "Upbeat" },
  { name: "Charon", description: "Informative" },
  { name: "Kore", description: "Firm" },
  { name: "Fenrir", description: "Excitable" },
  { name: "Leda", description: "Youthful" },
  { name: "Orus", description: "Firm" },
  { name: "Aoede", description: "Breezy" },
  { name: "Callirrhoe", description: "Easy-going" },
  { name: "Autonoe", description: "Bright" },
  { name: "Enceladus", description: "Breathy" },
  { name: "Iapetus", description: "Clear" },
  { name: "Umbriel", description: "Easy-going" },
  { name: "Algieba", description: "Smooth" },
  { name: "Despina", description: "Smooth" },
  { name: "Erinome", description: "Clear" },
  { name: "Algenib", description: "Gravelly" },
  { name: "Rasalgethi", description: "Informative" },
  { name: "Laomedeia", description: "Upbeat" },
  { name: "Achernar", description: "Soft" },
  { name: "Alnilam", description: "Firm" },
  { name: "Schedar", description: "Even" },
  { name: "Gacrux", description: "Mature" },
  { name: "Pulcherrima", description: "Forward" },
  { name: "Achird", description: "Friendly" },
  { name: "Zubenelgenubi", description: "Casual" },
  { name: "Vindemiatrix", description: "Gentle" },
  { name: "Sadachbia", description: "Lively" },
  { name: "Sadaltager", description: "Knowledgeable" },
  { name: "Sulafat", description: "Warm" },
]

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
 * + voice metadata. Falls back to appending text when {text} is missing.
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
  return `${rendered}\n\n${text}`.trim()
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
