import { execFileSync, spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { selectAffectedE2E } from "./lib/e2e-impact"
import { affectedRunMode } from "./lib/e2e-run-mode"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ZERO_SHA = /^0+$/

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim()
}

function smokeSpecs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) return smokeSpecs(absolute)
    return entry.name.endsWith(".smoke.spec.ts")
      ? [path.relative(REPO_ROOT, absolute).replaceAll("\\", "/")]
      : []
  })
}

function diffFiles(base: string, head: string): string[] {
  return git(["diff", "--name-only", `${base}..${head}`]).split("\n").filter(Boolean)
}

function changedFilesFromPush(stdin: string): string[] {
  const files = new Set<string>()
  for (const line of stdin.trim().split("\n").filter(Boolean)) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/)
    if (!localRef || !localSha || !remoteRef || !remoteSha || ZERO_SHA.test(localSha)) continue
    let base = remoteSha
    if (ZERO_SHA.test(remoteSha)) {
      const candidates = ["origin/dev", "origin/main"].filter((ref) => {
        try { git(["rev-parse", "--verify", ref]); return true } catch { return false }
      })
      base = candidates.length > 0 ? git(["merge-base", localSha, candidates[0]]) : `${localSha}^`
    }
    diffFiles(base, localSha).forEach((file) => files.add(file))
  }
  return [...files]
}

function changedFilesWithoutPushInput(): string[] {
  const explicitBaseIndex = process.argv.indexOf("--base")
  if (explicitBaseIndex >= 0 && process.argv[explicitBaseIndex + 1]) {
    return diffFiles(process.argv[explicitBaseIndex + 1], "HEAD")
  }
  try {
    const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    const base = git(["merge-base", "HEAD", upstream])
    return diffFiles(base, "HEAD")
  } catch {
    return diffFiles("HEAD^", "HEAD")
  }
}

const stdin = process.stdin.isTTY ? "" : readFileSync(0, "utf8")
const pushRefs = process.env.E2E_PUSH_REFS ?? stdin
const changedFiles = process.env.E2E_CHANGED_FILES
  ? process.env.E2E_CHANGED_FILES.split(/[\n,]/).map((file) => file.trim()).filter(Boolean)
  : pushRefs.trim()
    ? changedFilesFromPush(pushRefs)
    : changedFilesWithoutPushInput()
const impact = selectAffectedE2E(changedFiles, smokeSpecs(path.join(REPO_ROOT, "e2e/specs")))

console.log(`[e2e-affected] ${changedFiles.length} changed file(s) → ${impact.specs.length} smoke spec(s)`)
for (const reason of impact.reasons) console.log(`[e2e-affected] ${reason}`)

if (impact.specs.length === 0) {
  console.log("[e2e-affected] no browser journey affected; skipping E2E startup")
  process.exit(0)
}

const runMode = affectedRunMode(impact.specs.length)
console.log(
  `[e2e-affected] execution mode: ${runMode.shards} isolated ${runMode.viteMode} stack(s)`,
)
const result = spawnSync(
  "npx",
  runMode.shards === 1
    ? ["tsx", "scripts/e2e-up.ts", "--", ...impact.specs]
    : ["tsx", "scripts/e2e-shard.ts", String(runMode.shards), "--", ...impact.specs],
  {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, E2E_VITE_MODE: runMode.viteMode },
  },
)
process.exit(result.status ?? 1)
