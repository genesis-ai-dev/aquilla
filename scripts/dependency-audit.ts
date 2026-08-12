// CI gate against shipping a known-vulnerable dependency.
//
// Companion to scripts/secret-scan.ts, and built on the same principle: a
// check that fires on things nobody intends to act on gets ignored, and an
// ignored check is worse than no check because it looks like coverage. So this
// does NOT simply fail on `pnpm audit`'s exit code.
//
// THE PROBLEM WITH RAW `pnpm audit`
// Most advisories in this tree sit under the *Node* backends of
// `@huggingface/transformers` and `kokoro-js` — onnxruntime-node and sharp,
// and node-tar/adm-zip beneath them. `pnpm audit` walks the dependency graph,
// which does not know about conditional exports: transformers resolves to
// `dist/transformers.node.mjs` only under the `node` condition, and the web
// build we actually ship stubs onnxruntime-node out entirely (its bundle
// carries `// ignore-modules:onnxruntime-node` and an empty exports object,
// and never mentions sharp). Those advisories are real for a Node consumer and
// unreachable for ours.
//
// Failing every pull request on them trains everyone to skip the check, and
// the one advisory that DOES reach production goes past with the rest of the
// noise. That is not hypothetical: docs/OPSEC-REVIEW-2026-08-10.md OPS-6
// recorded "nothing yet prevents the next advisory", and two days later the
// next advisory was a DOMPurify XSS in a direct dependency of the SPA — the
// app's only sanitizer — sitting in the same `pnpm audit` output as seven
// unreachable ones.
//
// THE RULE
// Every advisory must be *triaged once*, by a human, into the allowlist file
// with a reason and a review-by date. Anything untriaged fails the build.
// An expired entry also fails, so "we'll look at it later" has a deadline
// attached rather than being a permanent silence. The gate is therefore on
// the triage, not on the advisory count — the number can go up without
// breaking anyone, and nothing goes un-looked-at.
//
// Usage:  pnpm audit:deps          (fails on untriaged or expired advisories)
//         pnpm audit:deps --list   (prints current advisories; triage aid)

import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))
export const ALLOWLIST_PATH = join(HERE, "dependency-audit-allowlist.json")

/** One triaged advisory. `until` is an ISO date; past it, the gate fails again. */
export interface AllowEntry {
  /** GitHub advisory id, e.g. "GHSA-r292-9mhp-454m". */
  id: string
  /** npm package the advisory is against. */
  module: string
  /** Why this does not reach production. Written for the next reader, not for the tool. */
  reason: string
  /** ISO date (YYYY-MM-DD) after which this entry stops suppressing. */
  until: string
}

export interface Advisory {
  id: string
  module: string
  severity: string
  title: string
  /** Dependency paths, e.g. ".>kokoro-js>@huggingface/transformers>…". */
  paths: string[]
}

export type Verdict =
  | { kind: "untriaged"; advisory: Advisory }
  | { kind: "expired"; advisory: Advisory; entry: AllowEntry }

/**
 * The audit could not be *performed* — as distinct from performing it and
 * finding something. Kept separate because the two need different reactions:
 * an untriaged advisory is a decision for whoever opened the pull request, and
 * an unreachable advisory endpoint is a problem with the build environment
 * that no change to this repository will fix.
 */
export class AuditUnavailableError extends Error {
  override readonly name = "AuditUnavailableError"
}

/**
 * Compare advisories against the allowlist. `today` is injected rather than
 * read from the clock so the test suite is not a time bomb.
 */
export function evaluate(
  advisories: Advisory[],
  allowlist: AllowEntry[],
  today: string,
): Verdict[] {
  const byId = new Map(allowlist.map((e) => [e.id, e]))
  const verdicts: Verdict[] = []
  for (const advisory of advisories) {
    const entry = byId.get(advisory.id)
    if (!entry) {
      verdicts.push({ kind: "untriaged", advisory })
      continue
    }
    // String compare is correct for zero-padded ISO dates and avoids dragging
    // a timezone into a build gate.
    if (entry.until < today) verdicts.push({ kind: "expired", advisory, entry })
  }
  return verdicts
}

/**
 * Normalise `pnpm audit --json` into the shape `evaluate` wants.
 *
 * Throws rather than returning `[]` when the payload carries neither
 * `advisories` nor `metadata`. A clean audit emits `advisories: {}` alongside
 * `metadata`, so a payload with neither is an unrecognised format — pnpm
 * changed its output, or something wrote a different JSON document to stdout.
 * Reporting that as "no advisories" would make this gate pass while checking
 * nothing, which is the precise failure mode it exists to prevent.
 */
export function parseAuditJson(raw: string): Advisory[] {
  const parsed = JSON.parse(raw) as {
    advisories?: Record<string, {
      github_advisory_id?: string
      module_name?: string
      severity?: string
      title?: string
      findings?: Array<{ paths?: string[] }>
    }>
    metadata?: unknown
  }
  if (parsed.advisories === undefined && parsed.metadata === undefined) {
    // Name the overwhelmingly likely cause. `pnpm audit` reports a registry or
    // proxy failure as an `error` object on stdout, and the advisory endpoint
    // (/-/npm/v1/security/audits) is a different surface from package
    // tarballs — a mirror can serve installs perfectly and not implement it.
    const detail =
      typeof (parsed as { error?: unknown }).error === "object"
        ? ` Registry reported: ${JSON.stringify((parsed as { error?: unknown }).error).slice(0, 300)}`
        : ""
    throw new AuditUnavailableError(
      "could not obtain an advisory report from `pnpm audit --json` — the payload " +
        `carried neither \`advisories\` nor \`metadata\`.${detail}`,
    )
  }
  const advisories: Advisory[] = []
  for (const [key, value] of Object.entries(parsed.advisories ?? {})) {
    const paths = (value.findings ?? []).flatMap((f) => f.paths ?? [])
    advisories.push({
      id: value.github_advisory_id ?? key,
      module: value.module_name ?? "(unknown)",
      severity: value.severity ?? "unknown",
      title: value.title ?? "",
      paths,
    })
  }
  return advisories
}

export function loadAllowlist(path: string = ALLOWLIST_PATH): AllowEntry[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { allow?: AllowEntry[] }
  return parsed.allow ?? []
}

/**
 * `pnpm audit` exits non-zero whenever any advisory exists, so a rejected
 * promise is the normal path and carries the JSON on stdout. Only a run that
 * produced no parseable stdout is a real failure.
 */
async function runAudit(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "pnpm",
      ["audit", "--prod", "--json"],
      { maxBuffer: 32 * 1024 * 1024 },
    )
    return stdout
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout
    if (stdout && stdout.trim()) return stdout
    throw new AuditUnavailableError(
      `\`pnpm audit\` produced no output: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Escape hatch for a build environment that cannot reach the advisory
 * endpoint at all. Deliberately an environment variable rather than a config
 * file: it should be a visible, deliberate act by whoever administers the
 * builder, not something that can drift into the repository and be forgotten.
 * When set, the gate still prints loudly — a skipped check that looks like a
 * passed check is the failure this whole script exists to avoid.
 */
const SKIP_VAR = "AQUILLA_DEP_AUDIT_ALLOW_UNAVAILABLE"

function describe(a: Advisory): string {
  // One representative path is enough to see whether it reaches the bundle;
  // the full list is noise in a build log.
  const path = a.paths[0] ?? "(no path reported)"
  return `  ${a.severity.toUpperCase()} ${a.module} — ${a.title}\n    ${a.id}\n    ${path}`
}

async function main(): Promise<void> {
  let advisories: Advisory[]
  try {
    advisories = parseAuditJson(await runAudit())
  } catch (err) {
    if (!(err instanceof AuditUnavailableError)) throw err
    if (process.env[SKIP_VAR] === "1") {
      console.warn(
        `[audit:deps] ⚠ SKIPPED — the advisory endpoint is unreachable and ${SKIP_VAR}=1.\n` +
          `            ${err.message}\n` +
          "            Dependency vulnerabilities were NOT checked for this build.",
      )
      return
    }
    console.error(
      `[audit:deps] could not run the audit — this is an environment problem, not a finding.\n\n` +
        `  ${err.message}\n\n` +
        "The advisory endpoint (/-/npm/v1/security/audits) is separate from package\n" +
        "downloads, so installs can succeed while this fails — check registry/proxy\n" +
        "reachability and any npm_config_registry override on the builder.\n\n" +
        `If this builder genuinely cannot reach it, set ${SKIP_VAR}=1 there. That is a\n` +
        "deliberate, visible downgrade: the gate then logs a warning and checks nothing.\n" +
        "It fails by default because a security check that quietly stops running is the\n" +
        "exact defect docs/OPSEC-REVIEW-2026-08-12.md was written about.",
    )
    process.exitCode = 1
    return
  }

  if (process.argv.includes("--list")) {
    console.log(`[audit:deps] ${advisories.length} advisory(ies) in the production tree:\n`)
    for (const a of advisories) console.log(`${describe(a)}\n`)
    return
  }

  const today = new Date().toISOString().slice(0, 10)
  const verdicts = evaluate(advisories, loadAllowlist(), today)

  if (verdicts.length === 0) {
    console.log(
      `[audit:deps] clean — ${advisories.length} advisory(ies), all triaged and unexpired.`,
    )
    return
  }

  const untriaged = verdicts.filter((v) => v.kind === "untriaged")
  const expired = verdicts.filter((v) => v.kind === "expired")

  if (untriaged.length > 0) {
    console.error(`[audit:deps] ${untriaged.length} untriaged advisory(ies):\n`)
    for (const v of untriaged) console.error(`${describe(v.advisory)}\n`)
  }
  if (expired.length > 0) {
    console.error(`[audit:deps] ${expired.length} allowlist entry(ies) past review date:\n`)
    for (const v of expired) {
      if (v.kind !== "expired") continue
      console.error(`${describe(v.advisory)}\n    review was due ${v.entry.until}\n`)
    }
  }

  console.error(
    "Fix by upgrading if the advisory reaches the browser bundle or a Worker.\n" +
      `Otherwise triage it into ${ALLOWLIST_PATH} with a reason and a review-by\n` +
      "date. An entry without a real reason is a silenced alarm, not a decision.",
  )
  process.exitCode = 1
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error("[audit:deps] audit failed to run:", err)
    process.exitCode = 1
  })
}
