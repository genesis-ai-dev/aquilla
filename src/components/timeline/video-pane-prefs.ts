// Caption preferences for the linked-video pane, and the two types that go
// with them. Split out 2026-08-11 so the controls overlay can own its own types
// without importing back from MediaVideoPane. Pure — no React.

export type SubtitleMode = "target" | "source" | "both" | "off"
/** Where the burned-in caption sits. "picture" is the default and the honest
 *  one: the exported video has no black bars, so that is where the line will
 *  really be. "bar" keeps the image completely clear for anyone reviewing the
 *  picture itself. (Sam, 2026-08-08) */
export type CaptionPlacement = "picture" | "bar"

const SUBTITLE_MODES: readonly SubtitleMode[] = ["target", "source", "both", "off"]
const SUBTITLE_MODE_KEY = "codex:video-subtitle-mode"
const CAPTION_PLACEMENTS: readonly CaptionPlacement[] = ["picture", "bar"]
const CAPTION_PLACEMENT_KEY = "codex:video-caption-placement"

/** Both lines, until someone says otherwise. (Sam, 2026-08-11 — was "target".)
 *  A file being timed against footage usually has no translation yet, so a
 *  target-only default burns nothing and reads as broken; and while translating,
 *  seeing the line you are working FROM against the picture is the job. */
const DEFAULT_SUBTITLE_MODE: SubtitleMode = "both"

/** Read the persisted caption preference. Deliberately global rather than
 *  per-project: it expresses how someone likes to watch, not anything about the
 *  material. An unrecognised stored value falls back rather than rendering. */
export function readSubtitleMode(): SubtitleMode {
  if (typeof window === "undefined") return DEFAULT_SUBTITLE_MODE
  try {
    const raw = window.localStorage.getItem(SUBTITLE_MODE_KEY)
    return SUBTITLE_MODES.includes(raw as SubtitleMode) ? (raw as SubtitleMode) : DEFAULT_SUBTITLE_MODE
  } catch {
    return DEFAULT_SUBTITLE_MODE
  }
}

export function writeSubtitleMode(mode: SubtitleMode): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(SUBTITLE_MODE_KEY, mode)
  } catch {
    /* ignore persistence failures */
  }
}

export function readCaptionPlacement(): CaptionPlacement {
  if (typeof window === "undefined") return "picture"
  try {
    const raw = window.localStorage.getItem(CAPTION_PLACEMENT_KEY)
    return CAPTION_PLACEMENTS.includes(raw as CaptionPlacement) ? (raw as CaptionPlacement) : "picture"
  } catch {
    return "picture"
  }
}

export function writeCaptionPlacement(placement: CaptionPlacement): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(CAPTION_PLACEMENT_KEY, placement)
  } catch {
    /* ignore persistence failures */
  }
}
