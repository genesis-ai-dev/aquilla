// Ported from codex-editor: src/exportHandler/vttUtils.ts (escapeVoiceName) and
// webviews/.../NewSourceUploader/importers/subtitles/index.ts (extractVoiceLabel).

/** Sanitize a name for use inside a WebVTT <v ...> voice tag. The annotation
 *  portion cannot contain `<`, `>`, or newlines. */
export function escapeVoiceName(label: string): string {
  return label.replace(/[<>]/g, "").replace(/\r?\n/g, " ").trim()
}

const VOICE_TAG_RE = /^\s*<v(?:\.[^>\s]+)*\s+([^>]+)>([\s\S]*?)(?:<\/v>\s*)?$/

/** Pull a leading `<v speaker>...</v>` (or open-ended `<v speaker>...`) off a
 *  cue payload. Returns { speaker: null, text } when no voice tag is present. */
export function extractVoiceLabel(cueText: string): { speaker: string | null; text: string } {
  const match = cueText.match(VOICE_TAG_RE)
  if (!match) return { speaker: null, text: cueText }
  const speaker = match[1].trim()
  const inner = match[2]
  return speaker.length > 0 ? { speaker, text: inner } : { speaker: null, text: cueText }
}
