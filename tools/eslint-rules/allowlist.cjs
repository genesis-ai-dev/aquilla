/**
 * Shared allowlist logic for the i18n regrowth guard (`no-unkeyed-string`).
 *
 * Everything here answers one question: "is this literal string, appearing in a
 * user-visible position, still not something a translator should ever see?"
 * If yes we stay silent. Precision matters more than recall — a rule that cries
 * wolf on `MP3` gets disabled, and then nothing is guarded at all.
 */

// Tokens that are the same in every locale: product names, file/format names,
// protocol and unit names, keyboard keys. A string made ONLY of these (plus
// punctuation, digits and separators) is not translatable content.
const ATOMIC_TERMS = new Set(
  [
    // Aquilla + partner product names
    'Aquilla', 'Codex', 'Honeycomb', 'Context', 'Paratext', 'Scripture Forge',
    'Door43', 'DCS', 'Gitea', 'unfoldingWord', 'Bible Aquifer', 'Aquifer',
    'Langquest', 'LangQuest', 'Modal', 'Cloudflare', 'OpenRouter', 'Neon',
    'GitHub', 'GitLab', 'Google', 'Google Drive', 'Dropbox', 'Monday.com',
    'Kokoro', 'Gemini', 'Claude', 'OpenAI', 'Anthropic', 'ElevenLabs',
    // file + data formats
    'USFM', 'USX', 'USJ', 'IDML', 'TSV', 'CSV', 'JSON', 'JSONL', 'XML', 'YAML',
    'HTML', 'MD', 'Markdown', 'PDF', 'DOCX', 'DOC', 'ODT', 'TXT', 'ZIP', 'SFM',
    'MP3', 'WAV', 'OGG', 'WEBM', 'M4A', 'FLAC', 'PNG', 'JPG', 'JPEG', 'SVG',
    'SQLite', 'Postgres', 'R2', 'S3', 'VTT', 'SRT',
    // technical nouns that ship untranslated in this domain
    'API', 'URL', 'URI', 'ID', 'UUID', 'HTTP', 'HTTPS', 'WS', 'WSS', 'SSE',
    'MCP', 'PAT', 'OAuth', 'SSO', 'TTS', 'STT', 'ASR', 'AI', 'LLM', 'CDN',
    'CPU', 'GPU', 'RAM', 'UTF-8', 'BOM', 'RTL', 'LTR', 'CLDR', 'ISO', 'BCP',
    'CI', 'PR', 'SHA', 'DOM', 'CSS', 'JS', 'TS', 'npm', 'pnpm',
    // keyboard keys / chords
    'Ctrl', 'Cmd', 'Alt', 'Opt', 'Option', 'Shift', 'Esc', 'Escape', 'Enter',
    'Return', 'Tab', 'Space', 'Backspace', 'Delete', 'Del', 'Home', 'End',
    'PageUp', 'PageDown', 'Fn', 'Meta', 'Super',
    // units / short scalars rendered as-is
    'px', 'ms', 'ms.', 's', 'kB', 'KB', 'MB', 'GB', 'TB', 'Hz', 'kHz', 'dB',
    'bpm', 'wpm', 'x', 'v',
  ].map((t) => t.toLowerCase()),
)

// Single glyphs / separators / ornaments that carry no language.
const PUNCT_ONLY = /^[\s\p{P}\p{S}\p{N}]*$/u

// Files whose strings are legitimately never translated. Each pattern is a
// deliberate scope decision (see docs/swarm/TRACES.md), not an oversight —
// changing this list is a design decision and needs a reason in the PR.
const IGNORED_FILE_PATTERNS = [
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /\/__tests__\//,
  /\/e2e\//,
  // Standalone marketing entries: prerendered, SEO-owned, English-only by design.
  /\/pages\/Homepage\//,
  /\/pages\/Beta\//,
  /\/pages\/CaseStudy\//,
  /\/marketing\//,
  // Legal pages: translated legal/privacy text creates liability the product
  // does not want to take on. English-by-policy, not a detector gap.
  /\/pages\/PrivacyPolicy\.tsx$/,
  /\/pages\/.*Terms.*\.tsx$/,
  // Dev-only + platform-admin surfaces: internal staff, English-only by policy.
  /\/DebugView\.tsx$/,
  /\/DevLogin/,
  /\/DevLogout/,
  /\/components\/admin\//,
  /\/pages\/AdminConsole\.tsx$/,
  /\/pages\/settings\/.*Debug/,
  // Storybook-ish / showcase surfaces if present.
  /\/showcase\//,
]

// JSX attributes whose string value reaches the user's eyes or screen reader.
const TRANSLATABLE_ATTRS = new Set([
  'alt',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'label',
  'tooltip',
  'description',
  'heading',
  'subtitle',
  'caption',
  'emptyMessage',
  'emptyLabel',
  'loadingText',
  'confirmText',
  'cancelText',
  'submitLabel',
  'helperText',
  'errorText',
  'content', // <AppTooltip content="…">
])

// Callees whose first string argument is shown to the user as a notification.
// Deliberately narrow: `new Error(...)` is excluded because in this codebase
// most Error messages are developer-facing and never rendered verbatim.
const USER_FACING_CALLS = [
  /^toast$/,
  /^toast\.(success|error|info|warning|loading|message)$/,
  /^(window\.)?(alert|confirm|prompt)$/,
]

function isIgnoredFile(filename) {
  const p = filename.replace(/\\/g, '/')
  return IGNORED_FILE_PATTERNS.some((re) => re.test(p))
}

/**
 * True when the literal is untranslatable content: punctuation, a lone glyph,
 * a number, an identifier-shaped token, or a phrase built only from atomic
 * terms (e.g. "USFM / USX", "Ctrl + Enter", "MP3, WAV").
 */
function isAllowedString(raw) {
  const s = raw.trim()
  if (s.length === 0) return true
  if (PUNCT_ONLY.test(s)) return true

  // Needs at least one run of 2+ letters to be a candidate word at all.
  if (!/\p{L}\p{L}/u.test(s)) return true

  // Identifier / code-shaped: camelCase without spaces, dotted paths, kebab
  // ids, CSS class strings, URLs, file paths, mime types, template-ish tokens.
  if (/^[a-z0-9]+([A-Z][a-z0-9]*)+$/.test(s)) return true // camelCase
  if (/^[A-Z][A-Z0-9_]+$/.test(s)) return true // CONST_CASE
  if (/^https?:\/\//i.test(s)) return true
  if (/^[a-z]+:\/\//i.test(s)) return true
  if (/^[./~]?[\w./@-]+\.(tsx?|jsx?|json|md|css|png|svg|sql|py|sh)$/i.test(s)) return true
  if (/^[a-z]+\/[a-z0-9.+-]+$/i.test(s) && !s.includes(' ')) return true // mime
  if (/^[a-z0-9]+([.-][a-z0-9]+)+$/i.test(s) && !s.includes(' ')) return true // dotted/kebab id

  // Phrase made only of atomic terms + separators.
  const words = s.split(/[\s/,+&|·—–\-()[\]{}:;.]+/u).filter(Boolean)
  if (words.length > 0 && words.every((w) => ATOMIC_TERMS.has(w.toLowerCase()))) return true

  return false
}

module.exports = {
  ATOMIC_TERMS,
  IGNORED_FILE_PATTERNS,
  TRANSLATABLE_ATTRS,
  USER_FACING_CALLS,
  isIgnoredFile,
  isAllowedString,
}
