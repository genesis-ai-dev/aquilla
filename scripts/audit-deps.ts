// Recurring dependency-vulnerability check across every lockfile in the repo.
//
// Why a script and not a bare `pnpm audit` in a workflow (OPS-6):
//
//  1. **Four lockfiles, one command.** The root SPA, auth-worker, sync-worker
//     and agent-worker each resolve independently. `pnpm audit` at the root
//     sees the first and none of the others, so the three Workers — the code
//     holding the signing keys — were the part nothing audited. The first run
//     of this script proved the point: three hono advisories in auth-worker,
//     including a `memo()` cross-user disclosure, invisible to a root audit.
//
//  2. **"Clean" and "audited nothing" must not look alike.** `pnpm audit`
//     prints "No known vulnerabilities found" and exits 0 whether it examined
//     four hundred packages or six. Run it from the wrong directory and you get
//     a green check for a tree you never looked at. This script fails when the
//     audit reports an implausibly small dependency count, so a mis-scoped run
//     is a failure rather than a pass.
//
//  3. **A green baseline makes a strict gate affordable.** As of 2026-08-13 the
//     production trees are at zero advisories, so any advisory is a real
//     regression and worth failing on. The previous review argued against a
//     per-PR audit because it fails on advisories in unrelated tooling and
//     trains people to ignore it — that reasoning still holds, which is why
//     this runs on a weekly schedule and audits production dependencies only.
//
// Usage:  pnpm audit:deps            fail on any production advisory
//         pnpm audit:deps --dev      include dev dependencies (informational)

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

interface Target {
  name: string
  dir: string
  command: string
  args: string[]
  /** Below this, assume the audit did not see the real tree. */
  minDependencies: number
}

const includeDev = process.argv.includes("--dev")

const TARGETS: Target[] = [
  {
    name: "root (SPA)",
    dir: ".",
    command: "pnpm",
    args: ["audit", ...(includeDev ? [] : ["--prod"]), "--json"],
    minDependencies: 200,
  },
  ...["auth-worker", "sync-worker", "agent-worker"].map((pkg) => ({
    name: pkg,
    dir: pkg,
    command: "npm",
    args: ["audit", ...(includeDev ? [] : ["--omit=dev"]), "--json"],
    minDependencies: 1,
  })),
]

interface Advisory {
  module: string
  severity: string
  title: string
  patched: string
  path: string
}

/** pnpm and npm emit different JSON shapes. Normalise both to one list. */
function parseAdvisories(raw: string): { advisories: Advisory[]; dependencies: number } {
  const json = JSON.parse(raw) as Record<string, unknown>

  // pnpm / npm v6 shape.
  if (json.advisories && typeof json.advisories === "object") {
    const meta = (json.metadata ?? {}) as { totalDependencies?: number }
    const advisories = Object.values(json.advisories as Record<string, {
      module_name: string
      severity: string
      title: string
      patched_versions: string
      findings?: Array<{ paths?: string[] }>
    }>).map((a) => ({
      module: a.module_name,
      severity: a.severity,
      title: a.title,
      patched: a.patched_versions,
      path: a.findings?.[0]?.paths?.[0] ?? a.module_name,
    }))
    return { advisories, dependencies: meta.totalDependencies ?? 0 }
  }

  // npm v7+ shape.
  const vulns = (json.vulnerabilities ?? {}) as Record<string, {
    severity: string
    via: Array<string | { title?: string; range?: string }>
    fixAvailable?: unknown
  }>
  const meta = (json.metadata ?? {}) as { dependencies?: { total?: number } }
  const advisories: Advisory[] = []
  for (const [name, v] of Object.entries(vulns)) {
    const source = v.via.find((entry) => typeof entry === "object") as
      | { title?: string; range?: string }
      | undefined
    // `via: [string]` means "vulnerable only because a dependency is" — the
    // dependency itself is reported separately, so don't count it twice.
    if (!source) continue
    advisories.push({
      module: name,
      severity: v.severity,
      title: source.title ?? "(no title)",
      patched: v.fixAvailable ? "fix available" : "no fix published",
      path: name,
    })
  }
  return { advisories, dependencies: meta.dependencies?.total ?? 0 }
}

function audit(target: Target): { advisories: Advisory[]; error?: string } {
  const dir = path.join(ROOT, target.dir)
  if (!existsSync(dir)) return { advisories: [], error: `${target.dir} does not exist` }

  let raw: string
  try {
    raw = execFileSync(target.command, target.args, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // Both tools exit non-zero when they find something; that is a result,
      // not a failure. A genuine failure throws without stdout.
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    const e = err as { stdout?: string; message?: string }
    if (!e.stdout) return { advisories: [], error: e.message ?? "audit failed to run" }
    raw = e.stdout
  }

  let parsed: { advisories: Advisory[]; dependencies: number }
  try {
    parsed = parseAdvisories(raw)
  } catch {
    return { advisories: [], error: "audit produced output this script could not parse" }
  }

  if (parsed.dependencies < target.minDependencies) {
    return {
      advisories: [],
      error:
        `audit saw only ${parsed.dependencies} dependencies (expected at least ` +
        `${target.minDependencies}) — treating as "did not run", not "clean"`,
    }
  }
  return { advisories: parsed.advisories }
}

const SEVERITY_ORDER = ["critical", "high", "moderate", "low", "info"]

function main(): void {
  let failed = false
  let total = 0

  for (const target of TARGETS) {
    const { advisories, error } = audit(target)
    if (error) {
      console.error(`[audit-deps] ${target.name}: ${error}`)
      failed = true
      continue
    }
    if (advisories.length === 0) {
      console.log(`[audit-deps] ${target.name}: clean`)
      continue
    }
    total += advisories.length
    failed = true
    console.error(`[audit-deps] ${target.name}: ${advisories.length} advisories`)
    const sorted = [...advisories].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    )
    for (const a of sorted) {
      console.error(`  ${a.severity.padEnd(8)} ${a.module} — ${a.title}`)
      console.error(`           via ${a.path}; patched ${a.patched}`)
    }
  }

  if (!failed) {
    console.log("[audit-deps] every lockfile clean.")
    return
  }
  if (total > 0) {
    console.error(
      `\n[audit-deps] ${total} advisory finding(s). Fix by raising the declared range, ` +
        `or — for a transitive dependency — an entry in the root package.json \`pnpm.overrides\`.`,
    )
  }
  process.exit(1)
}

main()
