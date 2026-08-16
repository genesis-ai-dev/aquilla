// Pre-push / CI guard against committing a live credential.
//
// This is a narrow, high-confidence scanner, not a general entropy detector.
// It matches only strings that carry a vendor-assigned prefix (or an
// unmistakable structure like a PEM header), because the failure mode that
// actually matters here is a real key pasted into a config file — and a
// scanner that cries wolf gets `--no-verify`'d into uselessness within a week.
//
// Deliberately NOT covered, and why:
//   - Bare high-entropy strings. Every content hash, UUID, and R2 object key in
//     this repo would trip that, and the projection/event tables are full of
//     them.
//   - Cloudflare account IDs. Public in every wrangler.toml by design; they are
//     identifiers, not authenticators.
//   - Rotated/expired keys. Nothing here can tell live from dead — a match is
//     "rotate this and find out how it got here", not "this is exploitable".
//
// Usage:  pnpm scan:secrets            (scans every git-tracked file)
//         pnpm scan:secrets -- --staged  (scans the staged diff only)
//
// Escape hatch: put `secret-scan:allow` in a comment on the same line. Use it
// for documentation examples, never to silence a real finding.

import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { pathToFileURL } from "node:url"

interface Rule {
  id: string
  description: string
  pattern: RegExp
}

const RULES: Rule[] = [
  {
    id: "private-key",
    description: "PEM private key block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    id: "aws-access-key",
    description: "AWS access key id",
    // Excludes the all-caps-alphabet placeholder used across the auth-worker
    // redaction tests (AKIAABCDEFGHIJKLMNOP).
    pattern: /\bAKIA(?!ABCDEFGHIJKLMNOP)[0-9A-Z]{16}\b/,
  },
  {
    id: "openai-key",
    description: "OpenAI / OpenRouter-style secret key",
    pattern: /\bsk-(?:or-v1-|ant-|proj-|live-)?[A-Za-z0-9_-]{32,}\b/,
  },
  {
    id: "github-token",
    description: "GitHub token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  },
  {
    id: "slack-token",
    description: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: "google-api-key",
    description: "Google / Gemini API key",
    // The onboarding validator's fixtures use AIzaSyA1b2C3… — a strict
    // ascending pattern no real key has.
    pattern: /\bAIza(?!SyA1b2C3)[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: "aquilla-pat",
    description: "Aquilla Agent API token (aqk_)",
    // Real tokens are base64url of 32 bytes → 43 chars after the tag. Test
    // fixtures use short stubs like aqk_abc123, which fall under the floor.
    pattern: /\baqk_[A-Za-z0-9_-]{40,}\b/,
  },
  {
    id: "postgres-url-password",
    description: "Postgres connection string with an inline password",
    // Neon/Hyperdrive URLs. `postgres://user@host` (no password) is fine.
    pattern: /\bpostgres(?:ql)?:\/\/[^\s:/@]+:[^\s:/@]{8,}@/,
  },
  {
    id: "wrangler-inline-secret",
    description: "secret assigned a value in a wrangler [vars] block",
    // [vars] is plain text in the deployed Worker config and shows up in
    // `wrangler deploy` output. Secrets belong in `wrangler secret put`.
    pattern: /^\s*(?:SECRET_KEY|SYNC_SECRET_KEY|OPENROUTER_API_KEY|RESEND_API_KEY|[A-Z_]*(?:_TOKEN|_SECRET|_PASSWORD))\s*=\s*["'][^"']{8,}["']/,
  },
]

/** Files whose matches are fixtures by construction. */
const ALLOWED_PATHS: RegExp[] = [
  /(^|\/)__tests__\//,
  /(^|\/)__stubs__\//,
  /(^|\/)__fixtures__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /(^|\/)e2e\//,
  // `.example` files are the documented place to show the SHAPE of a secret.
  // They are still scanned for private keys and real vendor prefixes below —
  // only the wrangler-inline-secret rule is relaxed, since `.dev.vars.example`
  // legitimately carries dev placeholder values like SECRET_KEY="dev-…".
]

/** Rules relaxed for `.example` files, which exist to show placeholder shapes. */
const EXAMPLE_ONLY_EXEMPT = new Set(["wrangler-inline-secret"])

/** Never scan: binary blobs, lockfiles, and vendored trees. */
const SKIPPED_PATHS: RegExp[] = [
  /(^|\/)(?:pnpm-lock\.yaml|package-lock\.json|Cargo\.lock|poetry\.lock)$/,
  /(^|\/)node_modules\//,
  /\.(?:png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp[34]|wav|webm|zip|pdf|onnx|bin|wasm)$/i,
]

const MAX_BYTES = 2 * 1024 * 1024

export interface Finding {
  file: string
  line: number
  rule: string
  description: string
  excerpt: string
}

/** Show enough to locate the value, never enough to use it. */
function redact(line: string, match: string): string {
  const head = match.slice(0, 6)
  return line.replace(match, `${head}…[redacted ${match.length} chars]`).trim().slice(0, 160)
}

export function scanContent(file: string, content: string): Finding[] {
  const isExample = file.endsWith(".example")
  const findings: Finding[] = []
  const lines = content.split("\n")
  for (const [index, line] of lines.entries()) {
    if (line.includes("secret-scan:allow")) continue
    for (const rule of RULES) {
      if (isExample && EXAMPLE_ONLY_EXEMPT.has(rule.id)) continue
      const match = rule.pattern.exec(line)
      if (!match) continue
      findings.push({
        file,
        line: index + 1,
        rule: rule.id,
        description: rule.description,
        excerpt: redact(line, match[0]),
      })
    }
  }
  return findings
}

export function isScannable(file: string): boolean {
  if (SKIPPED_PATHS.some((p) => p.test(file))) return false
  return !ALLOWED_PATHS.some((p) => p.test(file))
}

function trackedFiles(staged: boolean): string[] {
  const args = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
    : ["ls-files", "-z"]
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean)
}

function main(): void {
  const staged = process.argv.includes("--staged")
  const findings: Finding[] = []

  for (const file of trackedFiles(staged)) {
    if (!isScannable(file)) continue
    let content: string
    try {
      if (statSync(file).size > MAX_BYTES) continue
      content = readFileSync(file, "utf8")
    } catch {
      continue // deleted, unreadable, or not valid UTF-8
    }
    if (content.includes("\0")) continue // binary
    findings.push(...scanContent(file, content))
  }

  if (findings.length === 0) {
    console.log(
      `[secret-scan] clean — no credential patterns in ${staged ? "the staged diff" : "tracked files"}.`,
    )
    return
  }

  console.error(`[secret-scan] ${findings.length} possible credential(s):\n`)
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.description}`)
    console.error(`      ${f.excerpt}\n`)
  }
  console.error(
    "Treat every hit as live: rotate the credential first, then remove it from the\n" +
      "working tree AND from git history (the commit is the leak, not the file).\n" +
      "If this is genuinely a fixture, add `secret-scan:allow` on the line.",
  )
  process.exitCode = 1
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) main()
