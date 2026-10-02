// Which sound plays a linked-video file: the video's own, or the uploaded
// recording. (AQU-1565 follow-up)
//
// A file can carry two programmes at once: a linked YouTube video, which has
// its own soundtrack, and an uploaded recording cut into media rows. The
// transport used to decide between them with one test, "does any row play the
// shared recording?", and a yes made the recording the master: the picture
// went silent and followed the upload. Sam, 2026-10-02: keep the video's own
// sound and picture as the default, and play the upload only when the person
// picks it.
//
// So the choice is a preference, per file and per device, like mute and the
// caption mode. Its DEFAULT is the only rule here: a YouTube picture starts on
// its own sound; every other picture (the client's streamed films) keeps
// today's arrangement, where an imported recording is the master. Those films
// are cut from the same programme the recording came from, and nothing about
// them has changed.

import { useSyncExternalStore } from "react"
import { youTubeVideoId } from "@/lib/video/youtube"

export type PlaybackSource = "video" | "recording"

/** Persisted per file, like `aquilla:timelineAudibility:<fileId>`. */
export const playbackSourceKey = (fileId: string) => `aquilla:playbackSource:${fileId}`

/** The video's own sound for a YouTube picture, the recording otherwise. */
export function defaultPlaybackSource(coreMediaUrl: string | null | undefined): PlaybackSource {
  return coreMediaUrl && youTubeVideoId(coreMediaUrl) != null ? "video" : "recording"
}

/** Survives storage that refuses writes, so a pick still sticks until reload. */
const sessionOverrides = new Map<string, PlaybackSource>()

function readStored(fileId: string): PlaybackSource | null {
  try {
    const raw = localStorage.getItem(playbackSourceKey(fileId))
    return raw === "video" || raw === "recording" ? raw : null
  } catch {
    // Private mode or blocked storage: the default is a fine answer.
    return null
  }
}

/** The file's current choice: what this device stored, else the default. */
export function readPlaybackSource(
  fileId: string | null | undefined,
  coreMediaUrl: string | null | undefined,
): PlaybackSource {
  if (!fileId) return defaultPlaybackSource(coreMediaUrl)
  return sessionOverrides.get(fileId) ?? readStored(fileId) ?? defaultPlaybackSource(coreMediaUrl)
}

// One listener set for every file. A change is rare (a person picking from a
// menu), so waking every subscriber to re-read its own key is cheaper than a
// per-file listener map and cannot leave one surface behind another.
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Remember the choice for this file and tell every surface at once. */
export function setPlaybackSource(fileId: string, source: PlaybackSource): void {
  try {
    localStorage.setItem(playbackSourceKey(fileId), source)
  } catch {
    // Private mode: the choice still holds for this session, through the
    // in-memory override.
  }
  sessionOverrides.set(fileId, source)
  for (const l of listeners) l()
}

/** Test seam: forget every in-memory choice. */
export function __resetPlaybackSourceForTests(): void {
  sessionOverrides.clear()
  for (const l of listeners) l()
}

/**
 * The file's playback source, live. Every surface that decides who owns the
 * transport reads this one hook, so the pane, the playback bar and the
 * workspace can never disagree about which sound is playing.
 */
export function usePlaybackSource(
  fileId: string | null | undefined,
  coreMediaUrl: string | null | undefined,
): PlaybackSource {
  // The snapshot is the resolved value itself (a string), so React compares it
  // by value and only re-renders when the answer changes.
  const get = () => readPlaybackSource(fileId, coreMediaUrl)
  return useSyncExternalStore(subscribe, get, get)
}

/**
 * Does the uploaded recording drive this file's playback?
 *
 * `anyCellClockIsFileTime` is today's test (a row plays the shared recording,
 * so the queue's clock is a file position). It is necessary, not sufficient:
 * the person also has to have picked the recording, or be on a picture that
 * defaults to it.
 */
export function recordingDrivesPlayback(anyCellClockIsFileTime: boolean, source: PlaybackSource): boolean {
  return anyCellClockIsFileTime && source === "recording"
}
