// Browser-ready MMS-TTS languages. The default runtime uses the public
// Sherpa-ONNX MMS mirror, which exposes most Meta MMS-TTS language folders as
// model.onnx + tokens.txt. Set VITE_MMS_RUNTIME=transformers to keep the older
// small Xenova subset, or VITE_MMS_MODEL_REMOTE_HOST to use our own converted
// Transformers.js/R2 mirror.

export interface MmsLanguageOption {
  /** MMS / ISO-639-3 code as used in `Xenova/mms-tts-{code}` model ids. */
  code: string
  /** Human-readable name. */
  name: string
}

export const POPULAR_MMS_LANGUAGES: readonly MmsLanguageOption[] = [
  { code: "eng", name: "English" },
  { code: "spa", name: "Spanish" },
  { code: "fra", name: "French" },
  { code: "deu", name: "German" },
  { code: "por", name: "Portuguese" },
  { code: "rus", name: "Russian" },
  { code: "ara", name: "Arabic" },
  { code: "hin", name: "Hindi" },
  { code: "kor", name: "Korean" },
  { code: "ron", name: "Romanian" },
  { code: "vie", name: "Vietnamese" },
  { code: "yor", name: "Yoruba" },
] as const

function cleanTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

export const MMS_MODEL_REMOTE_HOST = cleanTrailingSlash(
  (import.meta.env.VITE_MMS_MODEL_REMOTE_HOST as string | undefined)?.trim() ?? "",
)
export const MMS_MODEL_REMOTE_PATH_TEMPLATE =
  (import.meta.env.VITE_MMS_MODEL_REMOTE_PATH_TEMPLATE as string | undefined)?.trim() ||
  "{model}/resolve/{revision}/"
export const MMS_MODEL_REPO_PREFIX =
  (import.meta.env.VITE_MMS_MODEL_REPO_PREFIX as string | undefined)?.trim() ||
  (MMS_MODEL_REMOTE_HOST ? "facebook/mms-tts-" : "Xenova/mms-tts-")
export const HAS_HOSTED_MMS_MODELS = MMS_MODEL_REMOTE_HOST.length > 0

const requestedMmsRuntime =
  ((import.meta.env.VITE_MMS_RUNTIME as string | undefined)?.trim().toLowerCase() || "sherpa-onnx")
export const MMS_RUNTIME: "sherpa-onnx" | "transformers" =
  HAS_HOSTED_MMS_MODELS || requestedMmsRuntime === "transformers"
    ? "transformers"
    : "sherpa-onnx"
export const USE_SHERPA_MMS_MODELS = MMS_RUNTIME === "sherpa-onnx"
export const MMS_SHERPA_ONNX_REPO =
  (import.meta.env.VITE_MMS_SHERPA_ONNX_REPO as string | undefined)?.trim() ||
  "willwade/mms-tts-multilingual-models-onnx"
export const MMS_SHERPA_ONNX_REMOTE_HOST = cleanTrailingSlash(
  (import.meta.env.VITE_MMS_SHERPA_ONNX_REMOTE_HOST as string | undefined)?.trim() ||
  "https://huggingface.co",
)
export const MMS_SHERPA_CACHE_KEY = "mms-sherpa-onnx-v1"
export const HAS_EXTENDED_MMS_MODELS = HAS_HOSTED_MMS_MODELS || USE_SHERPA_MMS_MODELS

export const SUPPORTED_MMS_LANGUAGE_CODES = POPULAR_MMS_LANGUAGES.map((l) => l.code)

const SUPPORTED_MMS_LANGUAGE_CODE_SET = new Set(SUPPORTED_MMS_LANGUAGE_CODES)
const MMS_LANGUAGE_CODE_RE = /^[a-z]{3}([-_][a-z0-9]+)?$/i

export function isSupportedMmsLanguageCode(value: string | undefined): boolean {
  if (!value) return false
  const code = value.trim().toLowerCase()
  return SUPPORTED_MMS_LANGUAGE_CODE_SET.has(code) || (HAS_EXTENDED_MMS_MODELS && MMS_LANGUAGE_CODE_RE.test(code))
}

export function mmsModelIdForLanguage(value: string): string | null {
  const code = value.trim().toLowerCase()
  if (!isSupportedMmsLanguageCode(code)) return null
  if (USE_SHERPA_MMS_MODELS) return `${MMS_SHERPA_ONNX_REPO}/${code}`
  return `${MMS_MODEL_REPO_PREFIX}${code}`
}

export function mmsSherpaModelUrlsForLanguage(value: string): { model: string; tokens: string } | null {
  const code = value.trim().toLowerCase()
  if (!isSupportedMmsLanguageCode(code)) return null
  const base = `${MMS_SHERPA_ONNX_REMOTE_HOST}/${MMS_SHERPA_ONNX_REPO}/resolve/main/${code}`
  return {
    model: `${base}/model.onnx`,
    tokens: `${base}/tokens.txt`,
  }
}

export function supportedMmsLanguageSummary(): string {
  if (USE_SHERPA_MMS_MODELS) {
    return "any MMS code available in the Sherpa-ONNX mirror, such as eng, spa, fra, ita, hun, or yor"
  }
  if (HAS_HOSTED_MMS_MODELS) {
    return "any hosted MMS code in the R2 mirror, such as eng, spa, fra, ita, hun, or yor"
  }
  return POPULAR_MMS_LANGUAGES.map((l) => `${l.name} (${l.code})`).join(", ")
}
