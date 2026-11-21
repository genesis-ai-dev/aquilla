/**
 * videos.json: what the help site reads. One entry per tutorial video, with
 * addresses that never change when a video is filmed again, so a page that
 * embeds one is written once.
 *
 * It also carries what each film was made from (its look, its script, the
 * frame's version, whether it has a voice), which is how the next run knows
 * which videos to publish again.
 */
import type { Audience } from "../../e2e/recordings/tutorials/catalog"

export interface VideoEntry {
  id: string
  title: string
  /** The first line the voice says: "Here's how to translate a verse." */
  description: string
  audience: Audience
  language: string
  src: string
  poster: string
  captions: string
  durationSeconds: number
  voiced: boolean
  /** When this film was made, and from which commit of the app. */
  filmedAt: string
  commit: string
  look: string
  script: string
  frame: number
}

export interface VideoManifest {
  /** Raised when a field is removed or changes meaning; adding one does not raise it. */
  version: 1
  generatedAt: string
  base: string
  videos: VideoEntry[]
}

export type Filmed = Omit<VideoEntry, "src" | "poster" | "captions" | "filmedAt" | "commit">

export function addresses(base: string, id: string, language: string): Pick<VideoEntry, "src" | "poster" | "captions"> {
  const root = `${base.replace(/\/$/, "")}/${id}/${id}`
  return { src: `${root}.mp4`, poster: `${root}.jpg`, captions: `${root}.${language}.vtt` }
}

/** Why a video is published again, or null when the film that is up still stands. */
export function whyPublish(previous: VideoEntry | undefined, next: Filmed): string | null {
  if (!previous) return "no film yet"
  if (previous.frame !== next.frame) return "the frame changed"
  if (previous.script !== next.script) return "its script changed"
  if (previous.look !== next.look) return "its screens changed"
  if (previous.voiced !== next.voiced) return next.voiced ? "it has a voice now" : "its voice is gone"
  return null
}

export interface Plan {
  manifest: VideoManifest
  /** The videos to upload, with why. */
  publish: { id: string; why: string }[]
}

/**
 * The next manifest. A video that did not change keeps its entry (and so its
 * filmedAt and commit); one that was not filmed this run (it failed, or the
 * run named other videos) keeps the film that is up.
 */
export function plan(
  previous: VideoManifest | null,
  filmed: readonly Filmed[],
  now: { at: string; commit: string; base: string },
): Plan {
  const before = new Map((previous?.videos ?? []).map((video) => [video.id, video]))
  const publish: Plan["publish"] = []
  const videos = new Map(before)
  for (const film of filmed) {
    const why = whyPublish(before.get(film.id), film)
    if (!why) continue
    publish.push({ id: film.id, why })
    videos.set(film.id, { ...film, ...addresses(now.base, film.id, film.language), filmedAt: now.at, commit: now.commit })
  }
  return {
    manifest: { version: 1, generatedAt: now.at, base: now.base, videos: [...videos.values()] },
    publish,
  }
}
