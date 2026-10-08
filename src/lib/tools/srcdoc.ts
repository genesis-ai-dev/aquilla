/**
 * Builds the srcdoc a tool runs in.
 *
 * The frame's sandbox is TOOL_SANDBOX: scripts and forms, nothing else. Forms
 * are allowed only so a tool's `submit` handlers fire (Chrome drops the event
 * entirely in a sandbox without allow-forms); the CSP's `form-action 'none'`
 * still forbids any actual submission/navigation.
 *
 * Prototype hosting: `<iframe sandbox="allow-scripts" srcdoc=…>` — no
 * allow-same-origin, so the frame has an OPAQUE origin (no cookies, no storage,
 * no access to the app's DOM or IndexedDB) — plus a meta CSP that forbids
 * every network fetch. Production plan: serve tools from a dedicated origin
 * (tools.aquilla.app) with the CSP as a response header, and add that origin
 * to `frame-src` in public/_headers, worker/security-headers.ts and the Tauri
 * CSP; srcdoc then becomes a `src=` to that origin. See docs/SMART-EXTENSIONS.md.
 */

import { TOOL_RUNTIME_SOURCE } from "./runtime-source"

/** The iframe sandbox for every tool frame (and the smoke frame). Never add
 *  allow-same-origin: it would give the tool the app's origin. */
export const TOOL_SANDBOX = "allow-scripts allow-forms"

/** The CSP every tool document carries. `connect-src 'none'` and the absent
 *  `allow-same-origin` are what make "no network, no app storage" true;
 *  `img-src data: blob:` lets tools draw generated images. */
export const TOOL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; " +
  "base-uri 'none'"

/**
 * JSON for embedding inside an inline `<script>`. `JSON.stringify` alone is not
 * safe there: a string containing `</script>` closes the element, `<!--`
 * changes how the HTML tokenizer reads the rest of the script, and U+2028 /
 * U+2029 were not valid in JS string literals before ES2019. Escaping `<`, `>`,
 * `&` and the two separators as \\u escapes keeps the value identical after
 * `JSON.parse`/evaluation while making the text inert to the HTML parser.
 */
export function embedJson(value: unknown): string {
  const json = JSON.stringify(value) ?? "null"
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

export interface ToolBoot {
  tool: { id: string; name: string; version: number }
  project: { id: string; name: string }
  user: { username: string; roleLevel: number | null }
  mount: "page" | "panel" | "inline" | "smoke"
  /** Inline mounts: the cell the tool sits under. */
  cell?: { fileId: string; cellId: string }
  theme: Record<string, string>
}

/** CSS variable names the host forwards into the tool so it can match the app. */
export const THEME_VARS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted",
  "--muted-foreground",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--destructive",
  "--ring",
] as const

/** Read the app's current theme variables from the host document. */
export function readThemeVars(doc: Document = document): Record<string, string> {
  const out: Record<string, string> = {}
  const style = getComputedStyle(doc.documentElement)
  for (const name of THEME_VARS) {
    const v = style.getPropertyValue(name).trim()
    if (v) out[name] = v
  }
  return out
}

const BASE_STYLE =
  "html,body{margin:0;padding:0;background:var(--background,#fff);color:var(--foreground,#111);" +
  "font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif}*{box-sizing:border-box}"

/** Splits a tool source into head/body parts. Tools may be a full document or
 *  a fragment; either way the host's CSP, boot data and runtime go FIRST so no
 *  tool code runs before the bridge exists. */
export function buildToolSrcdoc(source: string, boot: ToolBoot): string {
  const head =
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${TOOL_CSP}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${BASE_STYLE}</style>` +
    `<script>window.__AQUILLA_BOOT__=${embedJson(boot)};</script>` +
    `<script>${TOOL_RUNTIME_SOURCE}</script>`

  const doctype = /^\s*<!doctype[^>]*>/i
  const body = source.replace(doctype, "")
  const headOpen = /<head[^>]*>/i.exec(body)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return `<!doctype html>${body.slice(0, at)}${head}${body.slice(at)}`
  }
  const htmlOpen = /<html[^>]*>/i.exec(body)
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length
    return `<!doctype html>${body.slice(0, at)}<head>${head}</head>${body.slice(at)}`
  }
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
}
