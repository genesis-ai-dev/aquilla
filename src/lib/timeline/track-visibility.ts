// AQU-904 — which text tracks a translator has hidden, per file.
//
// A local view preference, exactly like the timeline's speaker mutes and zoom:
// hiding the audio track while you work the subtitles is not a project edit and
// must not travel to anyone else. Stored as the list of HIDDEN ids so a track
// imported later is visible by default (an allow-list would hide it).

const key = (fileId: string) => `codex:timelineHiddenTracks:${fileId}`

export function loadHiddenTracks(fileId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(fileId)) ?? "")
    if (Array.isArray(parsed)) return new Set(parsed.filter((v): v is string => typeof v === "string"))
  } catch {
    /* unset / private mode */
  }
  return new Set()
}

export function saveHiddenTracks(fileId: string, hidden: ReadonlySet<string>): void {
  try {
    localStorage.setItem(key(fileId), JSON.stringify([...hidden]))
  } catch {
    /* private mode — just won't persist */
  }
}
