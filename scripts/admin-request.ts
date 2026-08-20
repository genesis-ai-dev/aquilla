// Call a sync-worker admin/migration route without putting the credential in
// your shell history.
//
// The routes under /admin/* and /migrate/* take a bearer secret. The obvious
// way to call them is a curl with the secret inline, which writes it into
// ~/.bash_history, the terminal scrollback, and any session recorder or
// screen-share in the room. docs/OPSEC-REVIEW-2026-08-10.md calls that out as
// OPS-2 — the code is fine, the habit is the weakness.
//
// This reads the secret from the environment and never accepts it as an
// argument, so there is no invocation of this script that leaks it.
//
// Usage:
//   export AQUILLA_ADMIN_SECRET=$(op read op://…)     # or read -s, or a file
//   pnpm admin:request GET /admin/files/<projectId>/<fileId>/inspect
//   pnpm admin:request DELETE /admin/files/<projectId>/<fileId>
//   pnpm admin:request POST /admin/projects/<projectId>/rebuild-fts
//
//   AQUILLA_SYNC_WORKER_URL overrides the target host
//   (default https://api.aquilla.app/sync).
//
// Provisioning the secret itself:
//   wrangler secret put ADMIN_SECRET --env production   # in sync-worker/
// Until it is provisioned, SYNC_SECRET_KEY still works — but the point of this
// script is to stop that value being the one you type.

const DEFAULT_BASE = "https://api.aquilla.app/sync"
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])

function fail(message: string): never {
  console.error(`[admin-request] ${message}`)
  process.exit(1)
}

export function resolveSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.AQUILLA_ADMIN_SECRET?.trim()
  if (secret) return secret
  // Deliberately named separately: falling back to the signing key is the thing
  // we are trying to stop, so it has to be an explicit, visible choice.
  const legacy = env.AQUILLA_SYNC_SECRET_KEY?.trim()
  if (legacy) {
    console.warn(
      "[admin-request] using AQUILLA_SYNC_SECRET_KEY — that is the token-signing key.\n" +
        "               Provision ADMIN_SECRET on the Worker and switch to AQUILLA_ADMIN_SECRET.",
    )
    return legacy
  }
  fail("set AQUILLA_ADMIN_SECRET (never pass the secret as an argument)")
}

export function parseArgs(argv: string[]): { method: string; path: string; body?: string } {
  const [method, path, body] = argv
  if (!method || !path) fail("usage: admin-request <METHOD> <path> [jsonBody]")
  const upper = method.toUpperCase()
  if (!METHODS.has(upper)) fail(`unsupported method: ${method}`)
  if (!path.startsWith("/")) fail("path must start with '/'")
  // A secret pasted where the path goes would land in shell history anyway, so
  // refuse the shape rather than silently sending it.
  if (/^\/?(bearer|aqk_)/i.test(path)) fail("that looks like a credential, not a path")
  return { method: upper, path, ...(body ? { body } : {}) }
}

async function main(): Promise<void> {
  const { method, path, body } = parseArgs(process.argv.slice(2))
  const secret = resolveSecret(process.env)
  const base = (process.env.AQUILLA_SYNC_WORKER_URL ?? DEFAULT_BASE).replace(/\/$/, "")

  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  })

  const text = await res.text()
  console.log(`${res.status} ${res.statusText}`)
  if (text) console.log(text)
  if (!res.ok) process.exit(1)
}

if (process.argv[1]?.includes("admin-request")) {
  await main()
}
