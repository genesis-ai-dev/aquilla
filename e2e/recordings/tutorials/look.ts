import { createHash } from "node:crypto"

/**
 * A video's look: each line's screen as text (Playwright's accessibility
 * tree), with what changes from run to run taken out, hashed. Two films of the
 * same app at the same commit have the same look; a renamed button, a moved
 * step or a new panel gives a different one, and the video is filmed again
 * (docs/TUTORIAL-VIDEOS.md, "When a video is published again").
 *
 * Pictures are not compared: a waveform, an avatar's colour or a toast differ
 * between two runs that show the same thing.
 */

const VOLATILE: readonly [RegExp, string][] = [
  // The build stamp in the sidebar foot: "v0.2.4 · 22143b8 · 2026-11-17".
  [/\bv\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g, "<version>"],
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g, "<date>"],
  // Ids the app mints: UUIDs and the like, in urls and test ids.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  [/\b[0-9a-f]{7,40}\b/g, "<hash>"],
  [/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/gi, "<time>"],
  // A cell's automatic health arrives a moment after the row does.
  [/Automatic health (?:awaiting evidence|\d+%)/g, "Automatic health <state>"],
  [/\b(?:just now|\d+\s?(?:s|sec|seconds?|m|min|minutes?|h|hours?|d|days?) ago)\b/gi, "<ago>"],
]

/** A screen's accessibility tree without what differs between two runs. */
export function steadyScreen(ariaSnapshot: string): string {
  let text = ariaSnapshot
  for (const [pattern, replacement] of VOLATILE) text = text.replace(pattern, replacement)
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join("\n")
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/** One hash for a whole video, from its lines' screens in order. */
export function lookOf(screens: readonly string[]): string {
  return hashText(screens.map(steadyScreen).join("\n---\n"))
}
