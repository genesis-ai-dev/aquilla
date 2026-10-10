/**
 * Static lint for tool source — a build gate, NOT the security boundary.
 *
 * The boundary is the host: an opaque-origin `sandbox="allow-scripts"` iframe
 * with a `default-src 'none'; connect-src 'none'` CSP. The lint exists so the
 * builder fails fast (and can feed the model a precise repair message) when
 * generated code reaches for things the sandbox would block at runtime anyway,
 * and so obviously out-of-contract code never gets saved at all.
 */

/** Hard cap on one tool's source. */
export const MAX_TOOL_SOURCE_BYTES = 200 * 1024

interface BannedPattern {
  re: RegExp
  message: string
}

const BANNED: BannedPattern[] = [
  { re: /\bfetch\s*\(/, message: "fetch() is not available; use the aquilla bridge" },
  { re: /\bXMLHttpRequest\b/, message: "XMLHttpRequest is not available; use the aquilla bridge" },
  { re: /\bWebSocket\b/, message: "WebSocket is not available" },
  { re: /\bEventSource\b/, message: "EventSource is not available" },
  { re: /\bsendBeacon\b/, message: "navigator.sendBeacon is not available" },
  { re: /\bimportScripts\b/, message: "importScripts is not available" },
  { re: /(^|[^.\w$])eval\s*\(/, message: "eval() is banned" },
  { re: /\bnew\s+Function\b|(^|[^.\w$])Function\s*\(/, message: "the Function constructor is banned" },
  { re: /\bdocument\.cookie\b/, message: "cookies are not available" },
  { re: /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/, message: "browser storage is not available; use aquilla.storage" },
  { re: /\bwindow\.open\s*\(/, message: "window.open is not available" },
  { re: /\bwindow\.(parent|top|opener)\b|(^|[^.\w$])(parent|top)\.postMessage\b/, message: "talk to the host only through the aquilla bridge" },
  { re: /<script[^>]*\ssrc\s*=/i, message: "external scripts are not allowed; inline everything" },
  { re: /<link[^>]*\shref\s*=\s*["']?(https?:)?\/\//i, message: "external stylesheets are not allowed" },
  { re: /@import\s+url\(/i, message: "CSS @import is not allowed" },
  { re: /<meta[^>]*http-equiv/i, message: "meta http-equiv is not allowed" },
  { re: /<(iframe|object|embed)\b/i, message: "nested frames/objects are not allowed" },
  { re: /<base\b/i, message: "<base> is not allowed" },
]

export interface LintIssue {
  message: string
  /** 1-based line of the first match, when known. */
  line?: number
  excerpt?: string
}

export interface LintResult {
  ok: boolean
  issues: LintIssue[]
}

function lineOf(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

/** Lint one tool's single-file source. */
export function lintToolSource(source: string): LintResult {
  const issues: LintIssue[] = []
  const bytes = new TextEncoder().encode(source).byteLength
  if (bytes === 0) issues.push({ message: "source is empty" })
  if (bytes > MAX_TOOL_SOURCE_BYTES) {
    issues.push({ message: `source is ${bytes} bytes; the limit is ${MAX_TOOL_SOURCE_BYTES}` })
  }
  if (!/<script\b/i.test(source)) issues.push({ message: "a tool needs an inline <script>" })

  for (const { re, message } of BANNED) {
    const m = re.exec(source)
    if (!m) continue
    const line = lineOf(source, m.index)
    const excerpt = source.split("\n")[line - 1]?.trim().slice(0, 120)
    issues.push({ message, line, ...(excerpt ? { excerpt } : {}) })
  }
  return { ok: issues.length === 0, issues }
}

/** Render lint issues as the repair message the builder sends back. */
export function formatLintIssues(issues: LintIssue[]): string {
  return issues
    .map((i) => `- ${i.message}${i.line ? ` (line ${i.line}${i.excerpt ? `: ${i.excerpt}` : ""})` : ""}`)
    .join("\n")
}
