#!/usr/bin/env node
// OPS-6 — dependency-advisory check.
//
// June's SEC-7 was found by a human running `pnpm audit` by hand, and resolved
// itself through ordinary dependency drift rather than through any control. The
// August pass then found a live XSS advisory in `dompurify` — the SPA's own
// sanitizer — one day after a review that had called this exact gap out. So the
// point of this script is not to produce a report; it is to be a thing that goes
// red when something NEW appears.
//
// Design notes, both learned from the OPS-4/OPS-7 placebo findings:
//
//  * It runs on a schedule, not on pull requests. A per-PR advisory gate fails
//    on advisories in unrelated tooling that the PR author cannot fix, and the
//    trained response to that is to ignore the lane.
//  * It fails only on advisories that are NOT in `.github/audit-allowlist.json`.
//    An allowlist entry requires a written reason, so "we accept this" is a
//    recorded decision rather than a silence. Without the allowlist the job
//    would be red from its first run (the transitive Node-side advisories under
//    the browser ML libraries) and would teach people to skip it.
//
// Usage:
//   node scripts/audit-deps.mjs            # exits 1 on un-allowlisted advisories
//   node scripts/audit-deps.mjs --report   # never exits non-zero; prints only

import { execFileSync } from "node:child_process"
import { readFileSync, existsSync, appendFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const REPORT_ONLY = process.argv.includes("--report")
const ALLOWLIST_PATH = resolve(ROOT, ".github/audit-allowlist.json")

// Root is a pnpm workspace; each Worker carries its own package-lock.json and is
// installed with npm (see CLAUDE.md), so audit each with the tool that owns it.
const TARGETS = [
  { dir: ".", tool: "pnpm" },
  { dir: "auth-worker", tool: "npm" },
  { dir: "sync-worker", tool: "npm" },
  { dir: "agent-worker", tool: "npm" },
]

const SEVERITY_ORDER = ["critical", "high", "moderate", "low", "info"]

function runAudit({ dir, tool }) {
  const cwd = resolve(ROOT, dir)
  if (!existsSync(resolve(cwd, "package.json"))) return null
  const args =
    tool === "pnpm"
      ? ["audit", "--prod", "--json"]
      : ["audit", "--omit=dev", "--json"]
  try {
    // Both tools exit non-zero when advisories exist, so a throw is the normal
    // path and the payload we want is on stdout either way.
    return execFileSync(tool, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    if (typeof err.stdout === "string" && err.stdout.trim()) return err.stdout
    throw new Error(`${tool} audit failed in ${dir}: ${err.stderr || err.message}`)
  }
}

const ghsaOf = (text) => (String(text).match(/GHSA-[0-9a-z-]{14,}/i) || [null])[0]

/**
 * pnpm emits the npm-v6 `advisories` shape; npm v7+ emits `vulnerabilities`.
 * Normalise both to one record so the allowlist is keyed the same way
 * regardless of which tool produced the finding.
 */
function normalise(raw, dir) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`unparseable audit JSON from ${dir}`)
  }
  // A payload carrying none of the shapes this parser reads — no `advisories`
  // (pnpm/npm-v6), no `vulnerabilities` (npm v7+), not even `metadata` — is an
  // output-format change or an error object on stdout, not a clean audit. It
  // must fail here rather than read as "no advisories found": a gate that
  // passes because it could not read its input is worse than no gate.
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (!("advisories" in parsed) && !("vulnerabilities" in parsed) && !("metadata" in parsed))
  ) {
    throw new Error(
      `unrecognised audit payload from ${dir}: expected advisories, vulnerabilities, or metadata; got ${
        typeof parsed === "object" && parsed !== null ? `keys [${Object.keys(parsed).join(", ")}]` : typeof parsed
      }`,
    )
  }
  const out = []

  for (const advisory of Object.values(parsed.advisories ?? {})) {
    out.push({
      dir,
      module: advisory.module_name,
      severity: String(advisory.severity ?? "info").toLowerCase(),
      title: advisory.title ?? "(untitled)",
      ghsa: ghsaOf(advisory.url ?? "") ?? ghsaOf(advisory.references ?? ""),
    })
  }

  for (const [name, vuln] of Object.entries(parsed.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      // A string `via` is a transitive pointer to another entry in the same
      // report; the advisory itself is the object form. Skipping strings avoids
      // counting one advisory once per package in its dependency chain.
      if (typeof via === "string") continue
      out.push({
        dir,
        module: via.name ?? name,
        severity: String(via.severity ?? vuln.severity ?? "info").toLowerCase(),
        title: via.title ?? "(untitled)",
        ghsa: ghsaOf(via.url ?? ""),
      })
    }
  }

  // One advisory can surface through several paths; collapse to unique findings.
  const seen = new Set()
  return out.filter((f) => {
    const k = `${f.dir}|${f.ghsa ?? f.title}|${f.module}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return []
  const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"))
  return parsed.accepted ?? []
}

function isAllowed(finding, allowlist) {
  return allowlist.some((entry) => {
    if (entry.ghsa && finding.ghsa) {
      return entry.ghsa.toUpperCase() === finding.ghsa.toUpperCase()
    }
    // Fall back to module+title for advisories with no GHSA id in the payload.
    return entry.module === finding.module && entry.title === finding.title
  })
}

const bySeverity = (a, b) =>
  SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)

function main() {
  const allowlist = loadAllowlist()
  const findings = []
  for (const target of TARGETS) {
    const raw = runAudit(target)
    if (raw !== null) findings.push(...normalise(raw, target.dir))
  }

  const fresh = findings.filter((f) => !isAllowed(f, allowlist)).sort(bySeverity)
  const accepted = findings.filter((f) => isAllowed(f, allowlist)).sort(bySeverity)

  const lines = []
  lines.push(`## Dependency advisories`, "")
  lines.push(
    `${findings.length} advisory finding(s): **${fresh.length} new**, ${accepted.length} previously accepted.`,
    "",
  )

  if (fresh.length) {
    lines.push(`### New — not in the allowlist`, "")
    lines.push(`| Severity | Package | Where | Advisory |`, `|---|---|---|---|`)
    for (const f of fresh) {
      lines.push(
        `| ${f.severity} | \`${f.module}\` | \`${f.dir}\` | ${f.title} ${f.ghsa ? `(${f.ghsa})` : ""} |`,
      )
    }
    lines.push("")
    lines.push(
      `Either upgrade the dependency, or — if it is genuinely not reachable in`,
      `what we ship — add it to \`.github/audit-allowlist.json\` **with a reason**.`,
      "",
    )
  } else {
    lines.push(`No new advisories. :white_check_mark:`, "")
  }

  if (accepted.length) {
    lines.push(`<details><summary>${accepted.length} accepted</summary>`, "")
    for (const f of accepted) {
      lines.push(`- ${f.severity} \`${f.module}\` (${f.dir}) — ${f.title}`)
    }
    lines.push("", `</details>`, "")
  }

  const report = lines.join("\n")
  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
  }

  if (fresh.length && !REPORT_ONLY) process.exit(1)
}

main()
