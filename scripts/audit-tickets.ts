// Files one Linear ticket per audited (directory, package) for the weekly
// dependency audit. Input is the JSON that scripts/audit-deps.mjs writes
// (AUDIT_REPORT_JSON), plus optionally `cargo audit --json` output.
//
// It reuses the Jev nightly's Linear client (smart-tests/adversarial/linear.ts)
// and its fingerprint marker, so dedup works the same way: a ticket is found by
// the marker in its description. A found ticket gets its title and description
// brought up to date and nothing else. This script never changes a ticket's
// state, labels or assignee: once a person moves or closes one, it is theirs.
// "Accepted" lives in .github/audit-allowlist.json, not in a closed ticket.
//
// Usage:
//   pnpm exec tsx scripts/audit-tickets.ts --report audit-report.json [--cargo cargo-audit.json] [--dry-run]
//
// Without LINEAR_API_KEY it behaves as --dry-run: it prints what it would file.

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { marker } from "../smart-tests/adversarial/fingerprint"
import { LinearClient } from "../smart-tests/adversarial/linear"

export interface AuditFinding {
  dir: string
  ecosystem: "npm" | "cargo"
  module: string
  severity: string
  title: string
  ghsa: string | null
  url: string | null
  path: string | null
  fixedIn: string | null
  allowlisted: boolean
}

export interface AuditGroup {
  dir: string
  ecosystem: "npm" | "cargo"
  module: string
  severity: string
  findings: AuditFinding[]
}

export interface Hold {
  heading: string
  packages: string[]
  quote: string
}

const SEVERITY_ORDER = ["critical", "high", "moderate", "low", "info", "unrated"]
const rank = (severity: string) => {
  const i = SEVERITY_ORDER.indexOf(severity)
  return i === -1 ? SEVERITY_ORDER.length : i
}

/** One ticket per (dir, ecosystem, package); every advisory for it goes in that ticket. */
export function groupFindings(findings: AuditFinding[]): AuditGroup[] {
  const groups = new Map<string, AuditGroup>()
  for (const finding of findings) {
    if (finding.allowlisted) continue
    const key = [finding.dir, finding.ecosystem, finding.module].join("|")
    const group = groups.get(key) ?? {
      dir: finding.dir, ecosystem: finding.ecosystem, module: finding.module, severity: finding.severity, findings: [],
    }
    group.findings.push(finding)
    if (rank(finding.severity) < rank(group.severity)) group.severity = finding.severity
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    group.findings.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.ghsa ?? a.title).localeCompare(b.ghsa ?? b.title))
  }
  return [...groups.values()].sort(
    (a, b) => rank(a.severity) - rank(b.severity) || a.dir.localeCompare(b.dir) || a.module.localeCompare(b.module),
  )
}

/** Dir + ecosystem + package. The advisory set is left out so a new advisory updates the ticket. */
export function auditFingerprint(group: Pick<AuditGroup, "dir" | "ecosystem" | "module">): string {
  const key = ["dep-audit", group.dir, group.ecosystem, group.module].join("|")
  return createHash("sha256").update(key).digest("hex").slice(0, 12)
}

/**
 * Read the holds out of docs/DEPENDENCY-RULES.md. A hold is a `###` section
 * carrying a `<!-- holds: a, b/* -->` line; the section text becomes the quote.
 */
export function parseHolds(markdown: string): Hold[] {
  const holds: Hold[] = []
  const lines = markdown.split("\n")
  let current: { heading: string; body: string[] } | null = null
  const flush = () => {
    if (!current) return
    const text = current.body.join("\n")
    const match = text.match(/<!-- holds: (.+?) -->/)
    if (match) {
      holds.push({
        heading: current.heading.replace(/^###\s+/, ""),
        packages: match[1].split(",").map((p) => p.trim()).filter(Boolean),
        quote: text.replace(/<!-- holds: .+? -->\n?/, "").trim(),
      })
    }
    current = null
  }
  for (const line of lines) {
    if (/^#{2,3} /.test(line)) {
      flush()
      if (line.startsWith("### ")) current = { heading: line, body: [] }
    } else if (current) {
      current.body.push(line)
    }
  }
  flush()
  return holds
}

const matchesPattern = (name: string, pattern: string) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern

/** Package names along a dependency path, with versions stripped. */
function pathNames(path: string | null): string[] {
  if (!path) return []
  return path
    .split(/\s*>\s*/)
    .map((part) => part.trim().replace(/^(@?[^@]+)@\d.*$/, "$1"))
    .filter((part) => part && part !== ".")
}

/** The hold covering the package itself or any package on its dependency path. */
export function holdFor(group: AuditGroup, holds: Hold[]): Hold | null {
  const names = [group.module, ...group.findings.flatMap((f) => pathNames(f.path))]
  for (const name of names) {
    const hit = holds.find((hold) => hold.packages.some((pattern) => matchesPattern(name, pattern)))
    if (hit) return hit
  }
  return null
}

const where = (dir: string) => (dir === "." ? "root" : dir)

export function ticketTitle(group: AuditGroup): string {
  const n = group.findings.length
  const level = group.severity === "unrated" ? "severity unrated" : group.severity
  return `Dependency audit: ${group.module} in ${where(group.dir)} has ${n} ${n === 1 ? "advisory" : "advisories"} (${level})`
}

const VERIFY: Record<string, string> = {
  ".": "`pnpm test` and `pnpm test:worker` from the repo root",
  "src-tauri": "`cargo test` in `src-tauri`",
}
const verifyFor = (group: AuditGroup) =>
  VERIFY[group.dir] ?? `\`npm test\` in \`${group.dir}\` (and \`npx tsc --noEmit\` if it has a tsconfig)`

function fixOptions(group: AuditGroup): string[] {
  if (group.ecosystem === "cargo") {
    return [
      `1. Refresh the lockfile within the declared range: \`cargo update -p ${group.module}\` in \`src-tauri\`.`,
      "2. If a parent crate pins an old version, bump that parent within its range, or add a `[patch.crates-io]` entry.",
      "3. Only if the vulnerable code is not reachable in the desktop app: add the advisory id to an `ignore` list in `src-tauri/.cargo/audit.toml`, with a reachability reason in a comment and a review date.",
    ]
  }
  const overrides = group.dir === "." ? "`pnpm.overrides` in the root `package.json`" : `\`overrides\` in \`${group.dir}/package.json\``
  const update = group.dir === "." ? `\`pnpm update ${group.module} -r\`` : `\`npm update ${group.module}\` in \`${group.dir}\``
  return [
    `1. Bump the direct dependency that pulls it in, staying inside its declared range, or refresh the lockfile (${update}).`,
    `2. If no in-range release carries the fix, add an override (${overrides}) to a fixed version of the same major.`,
    "3. Only if the vulnerable code is not reachable in what ships: add an entry to `.github/audit-allowlist.json` with a reachability reason, `addedOn`, and a `reviewBy` date no more than a month out.",
  ]
}

export function ticketBody(group: AuditGroup, hold: Hold | null): string {
  const n = group.findings.length
  const paths = [...new Set(group.findings.map((f) => f.path).filter((p): p is string => Boolean(p)))]
  const fixed = [...new Set(group.findings.map((f) => f.fixedIn).filter((p): p is string => Boolean(p)))]
  const lines: (string | null)[] = [
    `The weekly dependency audit found ${n} ${n === 1 ? "advisory" : "advisories"} in \`${group.module}\` (${group.ecosystem}) in \`${where(group.dir)}\`. Highest severity: ${group.severity}.`,
    "",
    ...group.findings.map((f) => {
      const id = f.ghsa ?? f.title
      const link = f.url ? `[${id}](${f.url})` : id
      return `- ${link} (${f.severity}): ${f.title}${f.fixedIn ? `. Fixed in: ${f.fixedIn}` : ""}`
    }),
    "",
    paths.length ? `**Dependency path:** ${paths.map((p) => `\`${p}\``).join(", ")}` : "**Dependency path:** not reported by the audit.",
    fixed.length ? `**Fix available:** ${fixed.join(", ")}` : "**Fix available:** the audit names no fixed version.",
    "**Does it ship?** Unknown. The audit looks at production dependencies only, so this package is not dev-only in the lockfile, but that does not say whether it reaches a deployed bundle. Trace the path before deciding.",
    "",
    hold
      ? `**Held package.** \`docs/DEPENDENCY-RULES.md\` has a rule that covers this one (${hold.heading}). A person decides; agents skip this ticket.\n\n${hold.quote.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}`
      : null,
    hold ? "" : null,
    "+++ Agent notes",
    "",
    "Fix options, in order. Stop at the first one that works:",
    "",
    ...fixOptions(group),
    "",
    "Hard rules: never a major version bump without a human. Never touch a held package (see `docs/DEPENDENCY-RULES.md`). Do not change the allowlist for a package that ships without a written reachability argument.",
    "",
    "Verification before the PR is ready:",
    "",
    `- Run ${verifyFor(group)}.`,
    "- If the package reaches shipped code (a Worker or the web bundle), walk the PR's preview; CI cannot exercise Workers runtime behavior.",
    "- Re-run `node scripts/audit-deps.mjs --report` and confirm this package no longer appears as new.",
    "",
    "+++",
    "",
    marker(auditFingerprint(group)),
  ]
  return lines.filter((line) => line !== null).join("\n")
}

export interface PlannedTicket {
  group: AuditGroup
  fingerprint: string
  title: string
  body: string
  labels: string[]
}

// The Aquilla area label whose description covers "dependency bumps, security hardening".
const DEPENDENCY_LABELS = ["Infra & Deploy"]

export function planTickets(findings: AuditFinding[], holds: Hold[]): PlannedTicket[] {
  return groupFindings(findings).map((group) => {
    const hold = holdFor(group, holds)
    return {
      group,
      fingerprint: auditFingerprint(group),
      title: ticketTitle(group),
      body: ticketBody(group, hold),
      labels: ["Bug", `<${DEPENDENCY_LABELS.join("|")} if the team has one>`, ...(hold ? ["HITL"] : [])],
    }
  })
}

export type FileResult = { identifier: string; action: "created" | "updated" | "unchanged" }

const normalise = (text: string) => text.replace(/\r\n/g, "\n").trim()

/** The Jev client, plus the three calls the audit needs. It reuses its key handling, GraphQL transport and Triage lookup. */
export class AuditLinearClient extends LinearClient {
  private labelIds: Promise<Map<string, string>> | null = null

  private async labelsByName(): Promise<Map<string, string>> {
    this.labelIds ??= (async () => {
      const { teamId } = await this.resolve()
      const data = await this.request<{ issueLabels: { nodes: { id: string; name: string; team: { id: string } | null }[] } }>(
        `query { issueLabels(first: 250) { nodes { id name team { id } } } }`, {})
      const out = new Map<string, string>()
      for (const label of data.issueLabels.nodes) {
        // A label on this team beats a workspace-wide one of the same name.
        if (label.team && label.team.id !== teamId) continue
        if (!out.has(label.name) || label.team) out.set(label.name, label.id)
      }
      return out
    })()
    return this.labelIds
  }

  /** Never creates labels: a missing one is skipped. */
  async labelIdsFor(hold: boolean): Promise<string[]> {
    const known = await this.labelsByName()
    const wanted = ["Bug", DEPENDENCY_LABELS.find((name) => known.has(name)) ?? "", ...(hold ? ["HITL"] : [])]
    return wanted.map((name) => known.get(name)).filter((id): id is string => Boolean(id))
  }

  async fileTicket(ticket: PlannedTicket): Promise<FileResult> {
    const found = await this.request<{ issues: { nodes: { id: string; identifier: string; description: string | null }[] } }>(
      `query($m: String!) { issues(first: 1, filter: { description: { contains: $m } }) { nodes { id identifier description } } }`,
      { m: marker(ticket.fingerprint) })
    const existing = found.issues.nodes[0]
    if (existing) {
      if (normalise(existing.description ?? "") === normalise(ticket.body)) {
        return { identifier: existing.identifier, action: "unchanged" }
      }
      await this.request(`mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }`,
        { id: existing.id, i: { title: ticket.title, description: ticket.body } })
      return { identifier: existing.identifier, action: "updated" }
    }
    const ids = await this.resolve()
    const created = await this.request<{ issueCreate: { issue: { identifier: string } } }>(
      `mutation($i: IssueCreateInput!) { issueCreate(input: $i) { issue { identifier } } }`,
      { i: {
        teamId: ids.teamId, stateId: ids.triageId,
        labelIds: await this.labelIdsFor(ticket.labels.includes("HITL")),
        title: ticket.title, description: ticket.body,
      } })
    return { identifier: created.issueCreate.issue.identifier, action: "created" }
  }
}

/** Convert `cargo audit --json` output into the same finding shape. */
export function cargoFindings(json: unknown, dir = "src-tauri"): AuditFinding[] {
  const list = (json as { vulnerabilities?: { list?: unknown[] } })?.vulnerabilities?.list ?? []
  return list.map((entry) => {
    const e = entry as {
      advisory: { id: string; title: string; url?: string | null }
      versions?: { patched?: string[] }
      package: { name: string; version: string }
    }
    return {
      dir,
      ecosystem: "cargo",
      module: e.package.name,
      severity: "unrated",
      title: `${e.advisory.title} (${e.package.name} ${e.package.version})`,
      ghsa: e.advisory.id,
      url: e.advisory.url ?? `https://rustsec.org/advisories/${e.advisory.id}`,
      path: null,
      fixedIn: e.versions?.patched?.length ? e.versions.patched.join(", ") : null,
      allowlisted: false,
    }
  })
}

function listing(tickets: PlannedTicket[]): string {
  if (!tickets.length) return "No tickets to file: no un-allowlisted advisories."
  return tickets.map((t) => `- ${t.title}\n  labels: ${t.labels.join(", ")}`).join("\n")
}

async function main() {
  const args = process.argv.slice(2)
  const arg = (name: string) => {
    const i = args.indexOf(name)
    return i === -1 ? null : args[i + 1] ?? null
  }
  const reportPath = arg("--report")
  if (!reportPath) throw new Error("--report <audit-report.json> is required")
  const root = resolve(fileURLToPath(import.meta.url), "..", "..")

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { findings: AuditFinding[] }
  const cargoPath = arg("--cargo")
  if (cargoPath && existsSync(cargoPath)) {
    try {
      report.findings.push(...cargoFindings(JSON.parse(readFileSync(cargoPath, "utf8"))))
    } catch {
      console.error(`Could not read cargo audit JSON at ${cargoPath}; src-tauri findings are missing from this report.`)
    }
  }
  // The merged report (npm, pnpm and cargo) is what the workflow uploads.
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  const holds = parseHolds(readFileSync(resolve(root, "docs/DEPENDENCY-RULES.md"), "utf8"))
  const tickets = planTickets(report.findings, holds)

  const apiKey = process.env.LINEAR_API_KEY
  const dryRun = args.includes("--dry-run") || !apiKey
  const lines: string[] = []

  if (dryRun) {
    lines.push(
      args.includes("--dry-run") ? "Dry run: nothing was filed." : "LINEAR_API_KEY is not set: nothing was filed.",
      "",
      "Tickets that would be filed or updated in Linear (team Aquilla, state Triage):",
      listing(tickets),
    )
  } else {
    const client = new AuditLinearClient(apiKey)
    let failed = 0
    lines.push("Linear tickets (team Aquilla, state Triage):", "")
    for (const ticket of tickets) {
      try {
        const result = await client.fileTicket(ticket)
        lines.push(`- ${result.identifier} ${result.action}: ${ticket.title}`)
      } catch (error) {
        failed++
        lines.push(`- FAILED: ${ticket.title} (${(error as Error).message})`)
      }
    }
    if (!tickets.length) lines.push("No un-allowlisted advisories; nothing to file.")
    if (failed) process.exitCode = 1
  }

  const text = lines.join("\n")
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
