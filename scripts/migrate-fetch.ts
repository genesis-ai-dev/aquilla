#!/usr/bin/env tsx
// GitLab "discover + fetch" CLI for the legacy-Codex -> Aquilla migration.
//
// Authenticates to Frontier, lists Codex projects on the self-hosted GitLab,
// clones a chosen project, and dereferences its git-LFS media into a local
// working copy under ~/.codex-projects/<name> that the EXISTING importer
// (scripts/migrate.ts) can then ingest. Built specifically to reach Codex
// projects that are NOT on local disk (only on GitLab) — e.g. the Armenian
// "The Chosen" project.
//
// =============================== USAGE ====================================
//   npx tsx scripts/migrate-fetch.ts --list [--search <term>]
//       List accessible Codex projects (no clone).
//   npx tsx scripts/migrate-fetch.ts <project-id-or-search-term> [--out <dir>]
//       Clone + LFS-deref into ~/.codex-projects/ (or --out <dir>), then print
//       the exact `npx tsx scripts/migrate.ts <dir>` command to import it.
//
// =========================== ENV VARS (LIVE) ==============================
// Credentials (one of the two sets is REQUIRED — never hardcode/commit them):
//   FRONTIER_USERNAME + FRONTIER_PASSWORD   (preferred) Frontier login; the
//       server brokers a GitLab token + URL back for all GitLab/git/LFS calls.
//   FRONTIER_TOKEN    + GITLAB_URL          escape hatch: a GitLab token + the
//       GitLab base URL directly, skipping the Frontier round-trip.
// Optional:
//   FRONTIER_API      overrides the Frontier API endpoint
//                     (default https://api.frontierrnd.com/api/v1)
//
// Example (fetch the Armenian "The Chosen" project by search term):
//   FRONTIER_USERNAME=you FRONTIER_PASSWORD=secret \
//     npx tsx scripts/migrate-fetch.ts "the chosen"
// or by explicit project id (unambiguous):
//   FRONTIER_USERNAME=you FRONTIER_PASSWORD=secret \
//     npx tsx scripts/migrate-fetch.ts 1234
//
// NOTE: This file cannot be exercised against the live path without real
// Frontier credentials. The PURE helpers it relies on (pointer parsing, path
// mapping, pagination, sha256 verify, Codex detection) are unit-tested in the
// sibling *.test.ts files.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import git from "isomorphic-git"
import http from "isomorphic-git/http/node"
import { resolveCredentialsFromEnv, type GitLabCredentials } from "../src/lib/migrate/gitlab/auth"
import {
  discoverCodexProjects,
  resolveProjectSelector,
  type CodexProjectMatch,
} from "../src/lib/migrate/gitlab/api"
import { dereferenceLfs } from "../src/lib/migrate/gitlab/lfs"

/** Sanitize a project name into a filesystem-safe directory segment. */
function sanitizeName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
  return cleaned || "codex-project"
}

/** Default output root: ~/.codex-projects (matches where the importer looks). */
function defaultOutRoot(): string {
  return path.join(os.homedir(), ".codex-projects")
}

interface ParsedArgs {
  list: boolean
  search?: string
  out?: string
  selector?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { list: false }
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === "--list") {
      args.list = true
    } else if (token === "--search") {
      args.search = argv[++i]
    } else if (token === "--out") {
      args.out = argv[++i]
    } else if (token.startsWith("--search=")) {
      args.search = token.slice("--search=".length)
    } else if (token.startsWith("--out=")) {
      args.out = token.slice("--out=".length)
    } else if (token === "-h" || token === "--help") {
      printUsage()
      process.exit(0)
    } else if (token === "--no-lfs") {
      // boolean flag; consumed directly in main() via process.argv
    } else {
      positionals.push(token)
    }
  }
  if (positionals.length > 0) args.selector = positionals.join(" ")
  return args
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  npx tsx scripts/migrate-fetch.ts --list [--search <term>]",
      "  npx tsx scripts/migrate-fetch.ts <project-id-or-search-term> [--out <dir>]",
      "",
      "Env: FRONTIER_USERNAME + FRONTIER_PASSWORD  (preferred)",
      "     FRONTIER_TOKEN    + GITLAB_URL         (skip Frontier)",
      "     FRONTIER_API      (override API endpoint)",
      "",
    ].join("\n"),
  )
}

function fmtDate(iso: string): string {
  return iso ? iso.replace("T", " ").replace(/\..*$/, "") : "?"
}

async function runList(creds: GitLabCredentials, search?: string): Promise<void> {
  process.stderr.write(
    `Discovering Codex projects${search ? ` matching "${search}"` : ""}...\n`,
  )
  const matches = await discoverCodexProjects(creds, { search })
  if (matches.length === 0) {
    process.stdout.write("No accessible Codex projects found.\n")
    return
  }
  process.stdout.write(`Found ${matches.length} Codex project(s):\n\n`)
  for (const m of matches) {
    process.stdout.write(
      `  id=${m.id}  ${m.name}\n` +
        `       namespace: ${m.namespace}\n` +
        `       last activity: ${fmtDate(m.lastActivityAt)}\n\n`,
    )
  }
  process.stdout.write(
    "To fetch one: npx tsx scripts/migrate-fetch.ts <id>\n",
  )
}

async function cloneProject(
  match: CodexProjectMatch,
  creds: GitLabCredentials,
  outDir: string,
): Promise<void> {
  if (fs.existsSync(path.join(outDir, ".git"))) {
    process.stderr.write(
      `Repo already cloned at ${outDir}; reusing existing checkout.\n`,
    )
    return
  }
  fs.mkdirSync(outDir, { recursive: true })
  process.stderr.write(
    `Cloning ${match.httpUrlToRepo} (branch ${match.defaultBranch})...\n`,
  )
  await git.clone({
    fs,
    http,
    dir: outDir,
    url: match.httpUrlToRepo,
    ref: match.defaultBranch,
    singleBranch: true,
    depth: 1,
    onAuth: () => ({ username: "oauth2", password: creds.gitlabToken }),
  })
  process.stderr.write("Clone complete.\n")
}

async function runFetch(
  creds: GitLabCredentials,
  selector: string,
  outOverride?: string,
  noLfs = false,
): Promise<void> {
  const match = await resolveProjectSelector(creds, selector)
  process.stderr.write(
    `Selected: id=${match.id}  ${match.name}  (${match.namespace})\n`,
  )

  const outDir =
    outOverride ?? path.join(defaultOutRoot(), sanitizeName(match.name || String(match.id)))

  await cloneProject(match, creds, outDir)

  if (noLfs) {
    process.stderr.write("Skipping LFS deref (--no-lfs; text only)\n")
  } else {
    process.stderr.write("Dereferencing git-LFS media...\n")
    let lastLine = 0
    const result = await dereferenceLfs(outDir, match.httpUrlToRepo, creds.gitlabToken, {
      onProgress: (done, total) => {
        const pct = total === 0 ? 100 : Math.floor((done / total) * 100)
        if (pct !== lastLine) {
          lastLine = pct
          process.stderr.write(`  LFS ${done}/${total} (${pct}%)\r`)
        }
      },
    })
    process.stderr.write(
      `\nLFS deref: ${result.written} downloaded, ${result.skippedAlreadyPresent} already present, ${result.failures.length} failed (of ${result.total} pointers).\n`,
    )
  }

  // Final, machine-grep-able line on stdout: the import command.
  process.stdout.write(`\nReady to import: npx tsx scripts/migrate.ts ${outDir}\n`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!args.list && !args.selector) {
    printUsage()
    process.exit(1)
  }

  let creds: GitLabCredentials
  try {
    creds = await resolveCredentialsFromEnv()
  } catch (error) {
    process.stderr.write(
      `Authentication error: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  }
  process.stderr.write(`Authenticated. GitLab: ${creds.gitlabUrl}\n`)

  if (args.list) {
    await runList(creds, args.search)
    return
  }

  // selector is guaranteed present here (checked above).
  await runFetch(creds, args.selector as string, args.out, process.argv.includes("--no-lfs"))
}

main().catch((error) => {
  process.stderr.write(
    `\nFatal: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  )
  process.exit(1)
})
