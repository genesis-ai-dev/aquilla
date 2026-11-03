// Deterministic ElevenLabs API mock for local dev and tests (AQU-2299).
//
// Speaks just the slice of https://elevenlabs.io/docs/api-reference the
// sync-worker's /api/v1/elevenlabs/* proxy calls (sync-worker/src/elevenlabs-api.ts):
//
//   GET  /v1/user/subscription          a "creator" account with quota
//   GET  /v2/voices                     a handful of premade voices + any clones
//   GET  /v1/models                     the curated TTS models + the STS model
//   POST /v1/text-to-speech/{voice_id}  real, audible mp3 bytes
//   POST /v1/voice-changer/{voice_id}   real, audible mp3 bytes
//   POST /v1/voices/add                 a new voice id, then listed as "cloned"
//   GET  /previews/{name}.mp3           preview_url targets
//
// The audio is the character-voice previews in public/character-voices, so a
// generated or converted take is audible in the app. Keys (xi-api-key):
//
//   test-elevenlabs-key    valid
//   test-elevenlabs-quota  valid for reads, out of characters for audio
//   test-elevenlabs-free   valid, but the plan cannot clone
//   anything else          401 invalid_api_key
//
// Run: npx tsx scripts/mock-elevenlabs.ts [port]   (pnpm dev boots it on :9457)

import http from "node:http"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const MOCK_ELEVENLABS_VALID_KEY = "test-elevenlabs-key"
export const MOCK_ELEVENLABS_QUOTA_KEY = "test-elevenlabs-quota"
export const MOCK_ELEVENLABS_FREE_KEY = "test-elevenlabs-free"

const DEFAULT_PORT = 9457
const VOICES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "character-voices")

interface MockVoice {
  voice_id: string
  name: string
  category: "premade" | "cloned" | "generated" | "professional"
  labels: Record<string, string>
  description: string
  /** Which public/character-voices clip stands in for this voice. */
  sample: string
}

const PREMADE: readonly MockVoice[] = [
  { voice_id: "mockRachel01", name: "Rachel", category: "premade", labels: { accent: "american", gender: "female", age: "young" }, description: "Calm, clear narration", sample: "narrator-willow" },
  { voice_id: "mockAdam0001", name: "Adam", category: "premade", labels: { accent: "american", gender: "male", age: "middle aged" }, description: "Deep, steady narrator", sample: "narrator-hearth" },
  { voice_id: "mockCharlot1", name: "Charlotte", category: "premade", labels: { accent: "british", gender: "female", age: "middle aged" }, description: "Warm storyteller", sample: "mother-dove" },
  { voice_id: "mockGeorge01", name: "George", category: "premade", labels: { accent: "british", gender: "male", age: "old" }, description: "Gravelly elder", sample: "elder-oak" },
  { voice_id: "mockMatilda1", name: "Matilda", category: "premade", labels: { accent: "australian", gender: "female", age: "young" }, description: "Bright, upbeat", sample: "youth-lark" },
  { voice_id: "mockDesign01", name: "Old Fisherman", category: "generated", labels: { gender: "male", age: "old" }, description: "Designed from a prompt", sample: "fisherman" },
]

const MODELS = [
  { model_id: "eleven_multilingual_v2", name: "Eleven Multilingual v2", can_do_text_to_speech: true, can_do_voice_conversion: false },
  { model_id: "eleven_v3", name: "Eleven v3", can_do_text_to_speech: true, can_do_voice_conversion: false },
  { model_id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", can_do_text_to_speech: true, can_do_voice_conversion: false },
  { model_id: "eleven_multilingual_sts_v2", name: "Eleven Multilingual v2 (STS)", can_do_text_to_speech: false, can_do_voice_conversion: true },
]

export interface MockElevenLabsState {
  cloned: MockVoice[]
  charactersUsed: number
}

export function newMockElevenLabsState(): MockElevenLabsState {
  return { cloned: [], charactersUsed: 12_340 }
}

const CHARACTER_LIMIT = 100_000

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ detail: { type: "mock", code, status: code, message } }, { status })
}

const sampleCache = new Map<string, Uint8Array>()
function sampleBytes(name: string): Uint8Array {
  const safe = name.replace(/[^a-z0-9-]/g, "")
  let bytes = sampleCache.get(safe)
  if (!bytes) {
    bytes = new Uint8Array(readFileSync(path.join(VOICES_DIR, `${safe}.mp3`)))
    sampleCache.set(safe, bytes)
  }
  return bytes
}

const mp3 = (bytes: Uint8Array) =>
  new Response(bytes.slice().buffer as ArrayBuffer, { headers: { "Content-Type": "audio/mpeg" } })

/**
 * Handle one ElevenLabs API request. `origin` is where this mock is reachable,
 * used to build preview URLs.
 */
export async function handleMockElevenLabs(
  request: Request,
  state: MockElevenLabsState,
  origin: string,
): Promise<Response> {
  const url = new URL(request.url)
  const { pathname } = url

  if (request.method === "GET" && (pathname === "/" || pathname === "/healthz")) {
    return Response.json({ ok: true })
  }
  const preview = pathname.match(/^\/previews\/([a-z0-9-]+)\.mp3$/)
  if (request.method === "GET" && preview) {
    try {
      // Like ElevenLabs' public preview bucket, readable from any origin.
      const res = mp3(sampleBytes(preview[1]))
      res.headers.set("Access-Control-Allow-Origin", "*")
      return res
    } catch {
      return new Response("not found", { status: 404 })
    }
  }

  const key = request.headers.get("xi-api-key") ?? ""
  if (![MOCK_ELEVENLABS_VALID_KEY, MOCK_ELEVENLABS_QUOTA_KEY, MOCK_ELEVENLABS_FREE_KEY].includes(key)) {
    return errorResponse(401, "invalid_api_key", "Invalid API key")
  }
  const quotaExhausted = key === MOCK_ELEVENLABS_QUOTA_KEY
  const all = (): MockVoice[] => [...PREMADE, ...state.cloned]
  const voiceById = (id: string) => all().find((v) => v.voice_id === id)

  if (request.method === "GET" && pathname === "/v1/user/subscription") {
    return Response.json({
      tier: key === MOCK_ELEVENLABS_FREE_KEY ? "free" : "creator",
      status: "active",
      character_count: quotaExhausted ? CHARACTER_LIMIT : state.charactersUsed,
      character_limit: CHARACTER_LIMIT,
      can_use_instant_voice_cloning: key !== MOCK_ELEVENLABS_FREE_KEY,
      next_character_count_reset_unix: 1_893_456_000,
      voice_limit: 30,
      voice_slots_used: state.cloned.length,
    })
  }

  if (request.method === "GET" && pathname === "/v2/voices") {
    const search = url.searchParams.get("search")?.toLowerCase() ?? ""
    const category = url.searchParams.get("category")
    const voices = all()
      .filter((v) => !category || v.category === category)
      .filter((v) => !search || `${v.name} ${v.description} ${Object.values(v.labels).join(" ")}`.toLowerCase().includes(search))
      .map(({ sample, ...v }) => ({ ...v, preview_url: `${origin}/previews/${sample}.mp3` }))
    return Response.json({ voices, has_more: false, total_count: voices.length, next_page_token: null })
  }

  if (request.method === "GET" && pathname === "/v1/models") {
    return Response.json(MODELS)
  }

  const tts = pathname.match(/^\/v1\/text-to-speech\/([^/]+)$/)
  if (request.method === "POST" && tts) {
    const voice = voiceById(decodeURIComponent(tts[1]))
    if (!voice) return errorResponse(404, "voice_not_found", "Voice not found")
    let body: { text?: unknown; model_id?: unknown }
    try {
      body = (await request.json()) as { text?: unknown; model_id?: unknown }
    } catch {
      return errorResponse(400, "invalid_request", "Expected JSON")
    }
    if (typeof body.text !== "string" || !body.text.trim()) return errorResponse(400, "invalid_parameters", "text is required")
    if (quotaExhausted) return errorResponse(401, "quota_exceeded", "You have 0 characters remaining")
    state.charactersUsed += body.text.length
    return mp3(sampleBytes(voice.sample))
  }

  const sts = pathname.match(/^\/v1\/(?:voice-changer|speech-to-speech)\/([^/]+)$/)
  if (request.method === "POST" && sts) {
    const voice = voiceById(decodeURIComponent(sts[1]))
    if (!voice) return errorResponse(404, "voice_not_found", "Voice not found")
    const form = await request.formData().catch(() => null)
    if (!form || !(form.get("audio") instanceof Blob)) return errorResponse(400, "invalid_parameters", "audio is required")
    if (quotaExhausted) return errorResponse(401, "quota_exceeded", "You have 0 characters remaining")
    return mp3(sampleBytes(voice.sample))
  }

  if (request.method === "POST" && pathname === "/v1/voices/add") {
    if (key === MOCK_ELEVENLABS_FREE_KEY) {
      return errorResponse(403, "feature_not_available", "Instant voice cloning is not available on your plan")
    }
    const form = await request.formData().catch(() => null)
    const name = form?.get("name")
    const files = form?.getAll("files").filter((f): f is File => f instanceof Blob) ?? []
    if (typeof name !== "string" || !name.trim() || files.length === 0) {
      return errorResponse(400, "invalid_parameters", "name and at least one file are required")
    }
    const labelsRaw = form?.get("labels")
    let labels: Record<string, string> = {}
    try {
      labels = typeof labelsRaw === "string" ? (JSON.parse(labelsRaw) as Record<string, string>) : {}
    } catch { /* ignore malformed labels, like the real API's lenient parse */ }
    const voiceId = `mockClone${String(state.cloned.length + 1).padStart(3, "0")}`
    const description = form?.get("description")
    state.cloned.push({
      voice_id: voiceId,
      name: name.trim(),
      category: "cloned",
      labels,
      description: typeof description === "string" ? description : "",
      sample: "narrator-willow",
    })
    return Response.json({ voice_id: voiceId, requires_verification: false })
  }

  return errorResponse(404, "not_found", `No mock for ${request.method} ${pathname}`)
}

/** A node http server wrapping `handleMockElevenLabs`, with its own state. */
export function createMockElevenLabsServer(state: MockElevenLabsState = newMockElevenLabsState()): http.Server {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : DEFAULT_PORT
      const origin = `http://127.0.0.1:${port}`
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v)
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0
      const request = new Request(`${origin}${req.url ?? "/"}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
      })
      handleMockElevenLabs(request, state, origin)
        .then(async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
          res.end(Buffer.from(await response.arrayBuffer()))
        })
        .catch((err: unknown) => {
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ detail: { code: "mock_error", message: String(err) } }))
        })
    })
  })
  return server
}

const isDirectRun = process.argv.some((arg: string) =>
  arg.replace(/\\/g, "/").endsWith("scripts/mock-elevenlabs.ts"),
)

if (isDirectRun) {
  const port = Number(process.argv[2]) || DEFAULT_PORT
  createMockElevenLabsServer().listen(port, "127.0.0.1", () => {
    console.log(`[mock-elevenlabs] listening on http://127.0.0.1:${port} (key: ${MOCK_ELEVENLABS_VALID_KEY})`)
  })
}
