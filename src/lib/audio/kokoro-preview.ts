import { isBundledKokoroVoiceName } from "./kokoro-languages"

/** Static MP3s vendored under `public/kokoro-previews/`. */
export function kokoroPreviewUrl(voiceId: string): string {
  return `/kokoro-previews/${voiceId}.mp3`
}

export function hasKokoroPreview(voiceId: string | undefined): boolean {
  return isBundledKokoroVoiceName(voiceId)
}

type PreviewListener = (playingId: string | null) => void

let current: HTMLAudioElement | null = null
let currentId: string | null = null
const listeners = new Set<PreviewListener>()

function notify(playingId: string | null): void {
  for (const listener of listeners) listener(playingId)
}

export function subscribeKokoroPreview(listener: PreviewListener): () => void {
  listeners.add(listener)
  listener(currentId)
  return () => {
    listeners.delete(listener)
  }
}

export function stopKokoroPreview(): void {
  if (current) {
    current.pause()
    current.removeAttribute("src")
    current.load()
    current = null
  }
  if (currentId === null) return
  currentId = null
  notify(null)
}

/** Play this speaker's sample, or stop it if it is already playing. */
export function toggleKokoroPreview(voiceId: string): void {
  if (!hasKokoroPreview(voiceId)) return
  if (currentId === voiceId) {
    stopKokoroPreview()
    return
  }
  stopKokoroPreview()
  const audio = new Audio(kokoroPreviewUrl(voiceId))
  current = audio
  currentId = voiceId
  audio.addEventListener("ended", () => {
    if (current === audio) stopKokoroPreview()
  })
  notify(voiceId)
  void audio.play().catch(() => {
    if (current === audio) stopKokoroPreview()
  })
}
