/**
 * i18n-scan.ts (WS-SCAN) — whole-app scan for UI-facing strings the
 * `i18n/no-unkeyed-string` ESLint rule structurally cannot see.
 *
 * The rule (tools/eslint-rules/no-unkeyed-string.cjs) only inspects JSXText,
 * JSX attribute values, and the first argument of a small allowlisted set of
 * calls, scoped to `src/**\/*.tsx` (eslint.config.js). That leaves four blind
 * spots, documented in the rule's own header and re-verified here:
 *
 *   1. tmpl-expr     — template literals WITH expressions (`` `Deleted ${n} files` ``)
 *                       in a UI-facing position. Only zero-expression templates
 *                       are treated as static strings by the rule.
 *   2. hoisted-const — string literals inside `const` arrays/objects declared
 *                       outside component scope (`const OPTIONS = [{ label: 'Owner' }]`).
 *                       The rule has no data-flow analysis to know `.label`
 *                       later reaches JSX.
 *   3. non-tsx       — UI-facing strings in `src/**\/*.ts` (toast text, error
 *                       copy, option/label tables in `src/lib/**`). The rule
 *                       is scoped to `.tsx` only.
 *   4. ignored-file  — files matched by `IGNORED_FILE_PATTERNS` in
 *                       allowlist.cjs (legal/admin/dev-only/showcase). Exempt
 *                       by policy, not oversight — still enumerated here so
 *                       the exemption stays auditable, using the SAME
 *                       detectors the real rule would have run (JSXText,
 *                       translatable JSX attrs, notification calls).
 *
 * A finding's `class` is a property of the FILE + pattern, not just the
 * pattern: a template-with-expression inside an ignored file is reported as
 * `ignored-file`, not `tmpl-expr`, and any finding in a `.ts` file is
 * `non-tsx` even if it would otherwise look like `hoisted-const` — the
 * overriding reason it's invisible to the real rule is the file extension.
 * Precedence: ignored-file > non-tsx > {tmpl-expr, hoisted-const}.
 *
 * Reuses `isAllowedString` / `ATOMIC_TERMS` / `isIgnoredFile` /
 * `TRANSLATABLE_ATTRS` / `USER_FACING_CALLS` from
 * tools/eslint-rules/allowlist.cjs (a CommonJS module, loaded via
 * `createRequire`) so "translatable" means exactly what it means to the real
 * rule — no second, divergent definition.
 *
 * Usage:
 *   npx tsx scripts/i18n-scan.ts                  human summary to stdout
 *   npx tsx scripts/i18n-scan.ts --json            JSON array to stdout
 *   npx tsx scripts/i18n-scan.ts --json out.json   JSON array written to file
 *
 * See docs/swarm/I18N-COVERAGE-SCAN.md for the narrated inventory this feeds.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const require = createRequire(import.meta.url)
const allowlist = require("../tools/eslint-rules/allowlist.cjs") as {
  ATOMIC_TERMS: Set<string>
  IGNORED_FILE_PATTERNS: RegExp[]
  TRANSLATABLE_ATTRS: Set<string>
  USER_FACING_CALLS: RegExp[]
  isIgnoredFile: (filename: string) => boolean
  isAllowedString: (raw: string) => boolean
}
const { isIgnoredFile, isAllowedString, TRANSLATABLE_ATTRS, USER_FACING_CALLS } = allowlist

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SRC_ROOT = join(REPO_ROOT, "src")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindingClass = "tmpl-expr" | "hoisted-const" | "non-tsx" | "ignored-file"
export type Confidence = "high" | "medium" | "low"
export type Classification = "key-it" | "already-keyed" | `exempt-${string}`

export interface Finding {
  file: string
  line: number
  text: string
  class: FindingClass
  confidence: Confidence
  signal: string
  classification: Classification
}

interface RawFinding {
  node: ts.Node
  raw: string
  signal: string
  rawClass: "tmpl-expr" | "hoisted-const" | "non-tsx-signal"
  confidence: Confidence
}

// ---------------------------------------------------------------------------
// Translatable-name vocabularies (deliberately narrower than TRANSLATABLE_ATTRS
// in places — this is object-literal-property matching, not JSX attributes,
// so we don't want e.g. `content` bare-word collisions blowing up recall).
// ---------------------------------------------------------------------------

const TRANSLATABLE_PROP_NAMES = new Set([
  "label",
  "title",
  "description",
  "message",
  "placeholder",
  "hint",
  "summary",
  "heading",
  "text",
  "tooltip",
  "error",
  "subtitle",
  "caption",
  "helperText",
  "errorText",
  "emptyMessage",
  "emptyLabel",
  "loadingText",
  "confirmText",
  "cancelText",
  "submitLabel",
])

// Names that are essentially always end-user copy wherever they appear
// (vs. generic names like `text`/`content` that also show up on non-UI data).
const HIGH_CONFIDENCE_PROP_NAMES = new Set([
  "label",
  "title",
  "description",
  "message",
  "placeholder",
  "error",
  "errorText",
  "helperText",
  "tooltip",
  "heading",
  "subtitle",
  "caption",
])

// Hoisted vocabulary tables (`const STATUS_LABELS = { active: 'Active', ... }`)
// don't use a `label`-shaped property name — the key is the enum value. Catch
// these by variable-name convention or an explicit `Record<X, string>` type.
const VOCAB_NAME_RE = /(LABELS?|TITLES?|MESSAGES?|COPY|NAMES?|OPTIONS?|VOCAB|DESCRIPTIONS?)$/

const FUNCTION_SCOPE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
])

// ---------------------------------------------------------------------------
// File walk
// ---------------------------------------------------------------------------

// `src/lib/i18n/messages/**` and `src/lib/i18n/namespaces/**` ARE the i18n
// catalog: their string properties are either the already-keyed English
// source text itself (what `t()` resolves to — flagging it as "needs t()" is
// circular) or translator-facing context notes (`description:` sidecars)
// that are never rendered to an end user. Both are out of scope for a scan
// of *unlocalized* UI strings; they are also forbidden files for this agent
// to touch (see the workstream brief). The rest of `src/lib/i18n/**` (the
// engine: translate.ts, I18nProvider.tsx, RichMessage.tsx, …) is scanned
// normally — genuine hardcoded strings can still hide there.
const CATALOG_DIR_RE = /(^|\/)src\/lib\/i18n\/(messages|namespaces)(\/|$)/

/** True for a file the scanner should walk at all: .ts/.tsx, not a test file. */
export function isScannableFile(name: string): boolean {
  if (!/\.tsx?$/.test(name)) return false
  if (/\.(test|spec)\.tsx?$/.test(name)) return false
  return true
}

function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue
      if (CATALOG_DIR_RE.test(relative(REPO_ROOT, full).replace(/\\/g, "/") + "/")) continue
      walk(full, out)
      continue
    }
    if (!isScannableFile(entry.name)) continue
    out.push(full)
  }
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function calleeName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node) && !ts.isPrivateIdentifier(node.name)) {
    const obj = calleeName(node.expression)
    return obj ? `${obj}.${node.name.text}` : null
  }
  return null
}

function isNotificationCall(name: string | null): boolean {
  if (!name) return false
  return USER_FACING_CALLS.some((re) => re.test(name))
}

function isErrorConstructorName(name: string | null): boolean {
  if (!name) return false
  const last = name.split(".").pop() ?? ""
  return /Error$/.test(last)
}

/** Literal string or zero-expression template — the same notion the real rule uses. */
function staticStringOf(node: ts.Node | undefined): string | null {
  if (!node) return null
  if (ts.isStringLiteralLike(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

/** Static (quasi-only) skeleton of an interpolated template, expressions dropped. */
function templateSkeleton(node: ts.TemplateExpression): string {
  let s = node.head.text
  for (const span of node.templateSpans) s += span.literal.text
  return s
}

function templateDisplay(node: ts.TemplateExpression, sf: ts.SourceFile): string {
  let s = node.head.text
  for (const span of node.templateSpans) {
    s += "${" + span.expression.getText(sf) + "}" + span.literal.text
  }
  return s
}

function propNameOf(prop: ts.ObjectLiteralElementLike): string | null {
  const name = (prop as ts.PropertyAssignment).name
  if (!name) return null
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteralLike(name)) return name.text
  return null
}

function isRecordOfStringType(t: ts.TypeNode | undefined): boolean {
  if (!t || !ts.isTypeReferenceNode(t)) return false
  const name = t.typeName.getText()
  if (name !== "Record" && !name.endsWith(".Record")) return false
  const args = t.typeArguments
  if (!args || args.length !== 2) return false
  return args[1].kind === ts.SyntaxKind.StringKeyword
}

function displayText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, 100)
}

// Tailwind/CSS utility-class strings ("bg-blue-100 text-blue-700 dark:bg-…")
// pass `isAllowedString` (they're not camelCase/CONST_CASE/dotted-id, and
// they're not built from ATOMIC_TERMS) but are not UI copy. Flag anything
// containing a bracketed arbitrary value, a variant prefix, or a
// hyphen-then-digit color/scale suffix — none of which occur in prose.
const CSS_CLASS_HINT_RE =
  /\[[^\]\s]+\]|(^|\s)(dark|hover|focus|focus-visible|active|disabled|group|peer|sm|md|lg|xl|2xl):|-\d/
function looksLikeCssClassList(s: string): boolean {
  return CSS_CLASS_HINT_RE.test(s)
}

// ---------------------------------------------------------------------------
// Per-file scan
// ---------------------------------------------------------------------------

export function scanSource(relPath: string, text: string): Finding[] {
  const isTsx = relPath.endsWith(".tsx")
  const ignored = isIgnoredFile(relPath)
  const sf = ts.createSourceFile(
    relPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const raws: RawFinding[] = []
  let depth = 0

  function push(
    node: ts.Node,
    raw: string,
    signal: string,
    rawClass: RawFinding["rawClass"],
    confidence: Confidence,
  ) {
    const text = displayText(raw)
    if (!text) return
    raws.push({ node, raw: text, signal, rawClass, confidence })
  }

  function hasTemplateUiEvidence(
    node: ts.TemplateExpression,
  ): { evidence: string; confidence: Confidence } | null {
    const parent = node.parent
    if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
      const name = calleeName(parent.expression)
      if (name === "t" || (name && name.endsWith(".t"))) return null // key-building, not display text
      if (isNotificationCall(name)) return { evidence: `call:${name}`, confidence: "high" }
      return null
    }
    if (ts.isJsxExpression(parent)) {
      const gp = parent.parent
      if (ts.isJsxAttribute(gp)) {
        const attrName = ts.isIdentifier(gp.name) ? gp.name.text : null
        if (attrName && TRANSLATABLE_ATTRS.has(attrName)) {
          return { evidence: `jsx-attr:${attrName}`, confidence: "high" }
        }
        return null
      }
      if (ts.isJsxElement(gp) || ts.isJsxFragment(gp)) {
        return { evidence: "jsx-child", confidence: "high" }
      }
      return null
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
      const name = propNameOf(parent)
      if (name && TRANSLATABLE_PROP_NAMES.has(name)) {
        return {
          evidence: `object-prop:${name}`,
          confidence: HIGH_CONFIDENCE_PROP_NAMES.has(name) ? "high" : "medium",
        }
      }
      return null
    }
    return null
  }

  function handleTemplateExpression(node: ts.TemplateExpression) {
    const skeleton = templateSkeleton(node)
    if (isAllowedString(skeleton)) return // e.g. `${label}:` -> skeleton ":" -> punctuation-only
    const evidence = hasTemplateUiEvidence(node)
    if (!evidence) return
    push(node, templateDisplay(node, sf), evidence.evidence, "tmpl-expr", evidence.confidence)
  }

  // `isTopMap` is true only for the object literal that is the DIRECT
  // initializer of a hoisted `const` (e.g. `STATUS_LABELS = { active: 'Active' }`).
  // The var-name/Record<K,string> vocabulary heuristic is only trustworthy at
  // that level — inside an array-of-option-objects (`OPTIONS = [{ id: 'x',
  // label: 'X' }]`), the same heuristic would wrongly catch `id`/`ext`/`badge`
  // structural keys sitting next to the real `label`. Named translatable
  // properties (label/title/…) are still honored at any depth.
  function collectHoisted(node: ts.Node | undefined, varName: string, recordStringType: boolean, isTopMap: boolean) {
    if (!node) return
    if (ts.isArrayLiteralExpression(node)) {
      for (const el of node.elements) collectHoisted(el, varName, recordStringType, false)
      return
    }
    if (!ts.isObjectLiteralExpression(node)) return
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        collectHoisted(prop.expression, varName, recordStringType, false)
        continue
      }
      if (!ts.isPropertyAssignment(prop)) continue
      const name = propNameOf(prop)
      const val = prop.initializer
      const raw = staticStringOf(val)
      // `xClasses`/`xClassName` maps (Tailwind class lookup tables) match
      // VOCAB_NAME_RE's "NAMES?" tail and are often `Record<K, string>` —
      // exclude them explicitly rather than relying solely on the CSS-token
      // content sniff below (short single-utility values like "text-sm" or
      // "truncate" don't always contain a hyphen-digit/bracket/variant hint).
      const isCssLookupTable = /class(es|name)?$/i.test(varName)
      const isVocabShaped = isTopMap && !isCssLookupTable && (VOCAB_NAME_RE.test(varName) || recordStringType)
      if (raw !== null && !isAllowedString(raw) && !looksLikeCssClassList(raw)) {
        if (name && TRANSLATABLE_PROP_NAMES.has(name)) {
          push(
            prop,
            raw,
            `hoisted:${varName}.${name}`,
            "hoisted-const",
            HIGH_CONFIDENCE_PROP_NAMES.has(name) ? "high" : "medium",
          )
        } else if (isVocabShaped) {
          push(prop, raw, `hoisted:${varName}[${name ?? "?"}]`, "hoisted-const", "medium")
        }
      } else if (val && ts.isTemplateExpression(val)) {
        const skeleton = templateSkeleton(val)
        if (!isAllowedString(skeleton)) {
          if (name && TRANSLATABLE_PROP_NAMES.has(name)) {
            push(prop, templateDisplay(val, sf), `hoisted:${varName}.${name}(tmpl)`, "hoisted-const", "medium")
          } else if (isVocabShaped) {
            push(prop, templateDisplay(val, sf), `hoisted:${varName}[${name ?? "?"}](tmpl)`, "hoisted-const", "medium")
          }
        }
      }
      collectHoisted(val, varName, recordStringType, false)
    }
  }

  function handleTopLevelVariableStatement(stmt: ts.VariableStatement) {
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isIdentifier(decl.name)) continue
      const varName = decl.name.text
      const recordStringType = isRecordOfStringType(decl.type)
      collectHoisted(decl.initializer, varName, recordStringType, ts.isObjectLiteralExpression(decl.initializer))
    }
  }

  function handleNonTsxProperty(node: ts.PropertyAssignment) {
    const name = propNameOf(node)
    if (!name || !TRANSLATABLE_PROP_NAMES.has(name)) return
    const raw = staticStringOf(node.initializer)
    if (raw !== null) {
      if (isAllowedString(raw) || looksLikeCssClassList(raw)) return
      push(node, raw, `prop:${name}`, "non-tsx-signal", HIGH_CONFIDENCE_PROP_NAMES.has(name) ? "high" : "medium")
      return
    }
    if (ts.isTemplateExpression(node.initializer)) {
      const skeleton = templateSkeleton(node.initializer)
      if (isAllowedString(skeleton)) return
      push(node, templateDisplay(node.initializer, sf), `prop:${name}(tmpl)`, "non-tsx-signal", "medium")
    }
  }

  function handleNonTsxCall(node: ts.CallExpression) {
    const name = calleeName(node.expression)
    if (!isNotificationCall(name)) return
    const arg = node.arguments[0]
    if (!arg) return
    const raw = staticStringOf(arg)
    if (raw !== null) {
      if (isAllowedString(raw)) return
      push(arg, raw, `call:${name}`, "non-tsx-signal", "high")
      return
    }
    if (ts.isTemplateExpression(arg)) {
      const skeleton = templateSkeleton(arg)
      if (isAllowedString(skeleton)) return
      push(arg, templateDisplay(arg, sf), `call:${name}(tmpl)`, "non-tsx-signal", "high")
    }
  }

  // Only meaningful for ignored .tsx files: mirrors the real rule's own
  // JSXText / JSXAttribute / notification-call detectors, which never run
  // there because the file is excluded — but the strings should still be
  // enumerated so the exemption is auditable.
  function handleIgnoredJsxText(node: ts.JsxText) {
    const raw = node.text
    if (isAllowedString(raw)) return
    push(node, raw, "jsx-text", "non-tsx-signal", "high")
  }

  function handleIgnoredJsxAttribute(node: ts.JsxAttribute) {
    const attrName = ts.isIdentifier(node.name) ? node.name.text : null
    if (!attrName || !TRANSLATABLE_ATTRS.has(attrName)) return
    let valueNode: ts.Node | undefined = node.initializer
    if (valueNode && ts.isJsxExpression(valueNode)) valueNode = valueNode.expression
    const raw = staticStringOf(valueNode)
    if (raw === null || isAllowedString(raw)) return
    push(node, raw, `jsx-attr:${attrName}`, "non-tsx-signal", "high")
  }

  function handleIgnoredNotificationCall(node: ts.CallExpression) {
    const name = calleeName(node.expression)
    if (!isNotificationCall(name)) return
    const raw = staticStringOf(node.arguments[0])
    if (raw === null || isAllowedString(raw)) return
    push(node.arguments[0], raw, `call:${name}`, "non-tsx-signal", "high")
  }

  function visit(node: ts.Node) {
    // Type positions (string-literal unions, `Record<K, V>` type args, etc.)
    // are never UI copy — never recurse into them.
    if (ts.isTypeNode(node)) return

    if (FUNCTION_SCOPE_KINDS.has(node.kind)) {
      depth++
      ts.forEachChild(node, visit)
      depth--
      return
    }

    // Tagged templates (sql`...`, gql`...`, css`...`) are not UI text.
    if (ts.isTaggedTemplateExpression(node)) return

    if (ts.isNewExpression(node) && isErrorConstructorName(calleeName(node.expression))) {
      // `new Error(...)` / custom *Error(...) — developer-facing, never
      // rendered verbatim in this codebase (mirrors the real rule's own
      // deliberate exclusion of `new Error(...)`).
      return
    }

    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      if (name && (name === "console" || name.startsWith("console."))) return // developer logging
    }

    if (ts.isTemplateExpression(node)) {
      handleTemplateExpression(node)
      for (const span of node.templateSpans) visit(span.expression)
      return
    }

    if (isTsx && depth === 0 && ts.isVariableStatement(node)) {
      handleTopLevelVariableStatement(node)
    }

    if (!isTsx && ts.isPropertyAssignment(node)) {
      handleNonTsxProperty(node)
    }
    if (!isTsx && ts.isCallExpression(node)) {
      handleNonTsxCall(node)
    }

    if (ignored && isTsx) {
      if (ts.isJsxText(node)) handleIgnoredJsxText(node)
      if (ts.isJsxAttribute(node)) handleIgnoredJsxAttribute(node)
      if (ts.isCallExpression(node)) handleIgnoredNotificationCall(node)
    }

    ts.forEachChild(node, visit)
  }

  visit(sf)

  // Class precedence: ignored-file > non-tsx > {tmpl-expr, hoisted-const}.
  const findings: Finding[] = raws.map((r) => {
    const cls: FindingClass = ignored ? "ignored-file" : !isTsx ? "non-tsx" : (r.rawClass as FindingClass)
    const { line } = sf.getLineAndCharacterOfPosition(r.node.getStart(sf))
    return {
      file: relPath,
      line: line + 1,
      text: r.raw,
      class: cls,
      confidence: r.confidence,
      signal: r.signal,
      classification: classify(cls, relPath),
    }
  })

  // Dedup: multiple detectors can land on the same node (e.g. a template
  // literal inside a hoisted table's `label` property is visible to both the
  // generic template-expression walk and the hoisted-object walk). Keep the
  // highest-confidence copy.
  const rank: Record<Confidence, number> = { high: 2, medium: 1, low: 0 }
  const byKey = new Map<string, Finding>()
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.text}`
    const existing = byKey.get(key)
    if (!existing || rank[f.confidence] > rank[existing.confidence]) byKey.set(key, f)
  }
  return [...byKey.values()].sort((a, b) => a.line - b.line)
}

function exemptReason(relPath: string): string {
  if (/\/pages\/PrivacyPolicy\.tsx$/.test(relPath) || /\/pages\/.*Terms.*\.tsx$/.test(relPath)) return "legal"
  if (
    /\/DebugView\.tsx$/.test(relPath) ||
    /\/DevLogin/.test(relPath) ||
    /\/DevLogout/.test(relPath) ||
    /\/components\/admin\//.test(relPath) ||
    /\/pages\/AdminConsole\.tsx$/.test(relPath) ||
    /\/pages\/settings\/.*Debug/.test(relPath)
  ) {
    return "admin-dev"
  }
  if (/\/showcase\//.test(relPath)) return "showcase"
  return "policy"
}

function classify(cls: FindingClass, relPath: string): Classification {
  if (cls === "ignored-file") return `exempt-${exemptReason(relPath)}`
  return "key-it"
}

// ---------------------------------------------------------------------------
// Repo-wide scan + CLI
// ---------------------------------------------------------------------------

export function scanRepo(): Finding[] {
  const files: string[] = []
  walk(SRC_ROOT, files)
  const findings: Finding[] = []
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    const relPath = relative(REPO_ROOT, file).replace(/\\/g, "/")
    findings.push(...scanSource(relPath, text))
  }
  return findings
}

function printSummary(findings: Finding[]) {
  console.log(`i18n-scan: ${findings.length} findings across src/**\n`)

  const byClass = new Map<string, number>()
  for (const f of findings) byClass.set(f.class, (byClass.get(f.class) ?? 0) + 1)
  console.log("By class:")
  for (const [cls, n] of [...byClass].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls.padEnd(14)} ${n}`)
  }

  const byClassification = new Map<string, number>()
  for (const f of findings) byClassification.set(f.classification, (byClassification.get(f.classification) ?? 0) + 1)
  console.log("\nBy classification:")
  for (const [c, n] of [...byClassification].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(20)} ${n}`)
  }

  const byDir = new Map<string, number>()
  for (const f of findings) {
    const parts = f.file.split("/")
    const bucket = parts.slice(0, Math.min(3, parts.length - 1)).join("/") || f.file
    byDir.set(bucket, (byDir.get(bucket) ?? 0) + 1)
  }
  console.log("\nTop directories:")
  for (const [dir, n] of [...byDir].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(n).padStart(5)}  ${dir}`)
  }

  const byFile = new Map<string, number>()
  for (const f of findings) {
    if (f.classification !== "key-it") continue
    byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1)
  }
  console.log("\nTop files by key-it findings:")
  for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(n).padStart(5)}  ${file}`)
  }
}

function main() {
  const args = process.argv.slice(2)
  const jsonIdx = args.indexOf("--json")
  const findings = scanRepo()

  if (jsonIdx !== -1) {
    const maybeOut = args[jsonIdx + 1]
    const outPath = maybeOut && !maybeOut.startsWith("-") ? maybeOut : null
    const json = JSON.stringify(findings, null, 2)
    if (outPath) {
      writeFileSync(resolve(REPO_ROOT, outPath), json)
      console.log(`Wrote ${findings.length} findings to ${outPath}`)
    } else {
      console.log(json)
    }
    return
  }

  printSummary(findings)
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) main()
