// Open Bible Stories (OBS) markdown parser.
//
// Ports the codex-editor extension's `parseObsMarkdownContent`
// (webviews/.../importers/obs/index.ts) to the web app's TranslatableString
// model. Each OBS *frame* — an image line `![alt](src)` followed by a
// paragraph of story text — becomes exactly ONE cell. The frame's reference
// image rides along as row metadata (`metadata.attachments`), the same
// extensible bucket future gif/video/audio attachments will use. No separate
// image-only cells are produced.
//
// Deterministic and fully offline: this only parses an in-memory markdown
// string. Network fetching (door43) lives in import.ts's importObs().

import type { TranslatableString } from "./types"

/** One parsed OBS frame's attachment image, normalized for `metadata.attachments`. */
interface ObsImageAttachment {
  type: "image"
  url: string
  alt: string
}

/**
 * Parse a single OBS story markdown file into one TranslatableString per frame.
 *
 * Frame model (mirrors the editor):
 *   - The story title is the first `# ` heading; it becomes each frame's
 *     `section` label.
 *   - A frame is an image line (`![alt](src)`) plus the paragraph text that
 *     follows it. A frame's text accumulates consecutive non-empty,
 *     non-heading, non-image, non-reference lines; the image(s) seen since the
 *     last emitted frame are attached to it.
 *   - The trailing `_..._` line is the source reference (e.g. a Bible passage)
 *     and is NOT emitted as a cell.
 *
 * Each emitted frame carries:
 *   - `original`  = the frame's plain paragraph text
 *   - `group`     = `OBS <storyNumber>:<frameIndex>` (1-based frameIndex) — a
 *                   stable per-frame ref, threaded to `canonicalRef`.
 *   - `section`   = the story title
 *   - `context`   = the source reference (when present), for editor display
 *   - `type`      = "text"
 *   - `metadata`  = `{ attachments: [{ type: "image", url, alt }] }` — only when
 *                   the frame has an image.
 *
 * @param markdown Raw OBS story markdown.
 * @param fileName Optional file name; the leading `NN.md` digits seed the story
 *                 number (e.g. "01.md" → 1). Falls back to 0 when absent.
 */
export function parseObsStories(markdown: string, fileName?: string): TranslatableString[] {
  const lines = markdown.split(/\r?\n/)

  let title = ""
  let sourceReference = ""

  // Extract the story number from the file name (e.g. "01.md" → 1).
  let storyNumber = 0
  const fileMatch = fileName?.match(/(\d+)\.md$/)
  if (fileMatch) storyNumber = parseInt(fileMatch[1], 10)

  // First pass: pull out the title and source reference so every frame can
  // reference them. (The editor extracts these inline; we hoist them because we
  // emit frames as we go and want the title/ref available on the first frame.)
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith("# ") && !title) {
      title = line.substring(2).trim()
      continue
    }
    if (line.startsWith("_") && line.endsWith("_") && line.length > 1) {
      sourceReference = line.substring(1, line.length - 1)
    }
  }

  const frames: TranslatableString[] = []
  let currentText = ""
  let currentImages: ObsImageAttachment[] = []
  let frameIndex = 0

  const flush = () => {
    const hasText = currentText.trim().length > 0
    const hasImages = currentImages.length > 0
    // Skip a frame only when it has neither text nor an image.
    if (!hasText && !hasImages) return

    frameIndex += 1
    const ref = `OBS ${storyNumber}:${frameIndex}`
    const str: TranslatableString = {
      id: ref,
      original: currentText.trim(),
      translated: "",
      context: sourceReference || title,
      group: ref,
      section: title || undefined,
      type: "text",
    }
    if (hasImages) {
      str.metadata = { attachments: currentImages }
    }
    frames.push(str)

    currentText = ""
    currentImages = []
  }

  for (const raw of lines) {
    const line = raw.trim()

    // Title — consumed in the first pass; skip here.
    if (line.startsWith("# ")) continue

    // Source reference — consumed in the first pass; skip here.
    if (line.startsWith("_") && line.endsWith("_") && line.length > 1) continue

    // Image line — close any in-progress frame so each image starts a new one,
    // then collect the image(s) on this line.
    if (line.includes("![") && line.includes("](")) {
      if (currentText.trim().length > 0) flush()
      const imageMatches = line.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)
      for (const match of imageMatches) {
        currentImages.push({
          type: "image",
          url: match[2],
          alt: match[1] || "OBS Image",
        })
      }
      continue
    }

    // Blank line closes the current frame — but only once it has text. A blank
    // line right after a frame's image (the standard OBS layout: image, blank,
    // paragraph) must NOT flush, or the image would emit as a text-less cell.
    if (!line) {
      if (currentText.trim().length > 0) flush()
      continue
    }

    // Regular paragraph text accumulates into the current frame.
    currentText += (currentText ? " " : "") + line
  }

  // Emit any trailing in-progress frame.
  flush()

  return frames
}

/**
 * Multi-file convenience: parse several OBS story markdown files into one flat
 * list of frame cells, in the given order. Used by the door43 import path.
 */
export function parseObsStoriesMulti(
  files: Array<{ name: string; content: string }>,
): TranslatableString[] {
  const out: TranslatableString[] = []
  for (const file of files) {
    out.push(...parseObsStories(file.content, file.name))
  }
  return out
}
