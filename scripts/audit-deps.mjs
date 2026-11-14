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
// Allowlist entries expire: once an entry's `reviewBy` date has passed it stops
// matching, so the advisory goes red again and someone has to re-decide.
//
// Usage:
//   node scripts/audit-deps.mjs            # exits 1 on un-allowlisted advisories
//   node scripts/audit-deps.mjs --report   # never exits non-zero; prints only
//   node scripts/audit-deps.mjs --dry-run  # also prints the Linear tickets the weekly
//                                          # workflow would file; files nothing
//
// Set AUDIT_REPORT_FILE to also write the markdown report to that path, and
// AUDIT_REPORT_JSON to write the machine-readable findings (every finding with
// its package, advisories, path and allowlisted flag). scripts/audit-tickets.ts
// reads that JSON and files or updates one Linear ticket per package.

import { execFileSync } from "node:child_process"
import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DRY_RUN = process.argv.includes("--dry-run")
const REPORT_ONLY = process.argv.includes("--report") || DRY_RUN
const ALLOWLIST_PATH = resolve(ROOT, ".github/audit-allowlist.json")

// Root is a pnpm workspace; each Worker carries its own package-lock.json and is
// installed with npm (see CLAUDE.md), so audit each with the tool that owns it.
const TARGETS = [
  { dir: ".", tool: "pnpm" },
  { dir: "auth-worker", tool: "npm" },
  { dir: "sync-worker", tool: "npm" },
  { dir: "agent-worker", tool: "npm" },
  { dir: "monitor-worker", tool: "npm" },
  { dir: "zapier", tool: "npm" },
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
      url: advisory.url ?? null,
      path: advisory.findings?.[0]?.paths?.[0] ?? null,
      fixedIn: advisory.patched_versions && advisory.patched_versions !== "<0.0.0" ? advisory.patched_versions : null,
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
        url: via.url ?? null,
        path: [...(vuln.effects ?? []), name].join(" > "),
        fixedIn:
          vuln.fixAvailable && typeof vuln.fixAvailable === "object"
            ? `${vuln.fixAvailable.name}@${vuln.fixAvailable.version}${vuln.fixAvailable.isSemVerMajor ? " (major)" : ""}`
            : null,
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

// An entry with no `reviewBy` never expires; one whose date has passed (UTC,
// compared as YYYY-MM-DD) no longer counts.
const TODAY = new Date().toISOString().slice(0, 10)
const isExpired = (entry) => Boolean(entry.reviewBy) && entry.reviewBy < TODAY

function isAllowed(finding, allowlist) {
  return allowlist.some((entry) => {
    if (isExpired(entry)) return false
    if (entry.ghsa && finding.ghsa) {
      return entry.ghsa.toUpperCase() === finding.ghsa.toUpperCase()
    }
    // Fall back to module+title for advisories with no GHSA id in the payload.
    return entry.module === finding.module && entry.title === finding.title
  })
}

const bySeverity = (a, b) =>
  SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)

let reportJsonForDryRun = null

function main() {
  const allowlist = loadAllowlist()
  const findings = []
  for (const target of TARGETS) {
    const raw = runAudit(target)
    if (raw !== null) findings.push(...normalise(raw, target.dir))
  }

  const expired = allowlist.filter(isExpired)
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

  if (expired.length) {
    lines.push(
      `${expired.length} allowlist entr${expired.length === 1 ? "y is" : "ies are"} past \`reviewBy\` and no longer suppress anything. Re-decide each one, then extend its date or delete it:`,
      "",
    )
    for (const e of expired) {
      lines.push(`- \`${e.module}\` ${e.ghsa ?? e.title} (reviewBy ${e.reviewBy})`)
    }
    lines.push("")
  }

  if (accepted.length) {
    lines.push(`<details><summary>${accepted.length} accepted</summary>`, "")
    for (const f of accepted) {
      lines.push(`- ${f.severity} \`${f.module}\` (${f.dir}) — ${f.title}`)
    }
    lines.push("", `</details>`, "")
  }

  if (process.env.AUDIT_REPORT_JSON || DRY_RUN) {
    const jsonPath = process.env.AUDIT_REPORT_JSON ?? resolve(tmpdir(), "audit-report.json")
    const record = (f, allowlisted) => ({
      ...f,
      ecosystem: "npm",
      allowlisted,
    })
    writeFileSync(
      jsonPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          findings: [...fresh.map((f) => record(f, false)), ...accepted.map((f) => record(f, true))],
          expiredAllowlist: expired,
        },
        null,
        2,
      )}\n`,
    )
    if (DRY_RUN) {
      const args = ["exec", "tsx", "scripts/audit-tickets.ts", "--report", jsonPath, "--dry-run"]
      if (process.env.CARGO_AUDIT_JSON) args.push("--cargo", process.env.CARGO_AUDIT_JSON)
      reportJsonForDryRun = { args }
    }
  }

  const report = lines.join("\n")
  console.log(report)
  if (process.env.AUDIT_REPORT_FILE) {
    writeFileSync(process.env.AUDIT_REPORT_FILE, `${report}\n`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
  }

  if (reportJsonForDryRun) {
    console.log("")
    execFileSync("pnpm", reportJsonForDryRun.args, { cwd: ROOT, stdio: "inherit" })
  }

  if (fresh.length && !REPORT_ONLY) process.exit(1)
}

main()
