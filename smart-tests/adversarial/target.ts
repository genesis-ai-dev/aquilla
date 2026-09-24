/**
 * Where the adversarial suite may run. The guard runs in the launcher and
 * again in the Playwright config, before any browser opens.
 */
export type TargetKind = "local" | "dev" | "prod-canary"

export interface TargetUrls {
  baseURL: string
  identityBase: string
  syncBase: string
}

const DEPLOYED: Record<Exclude<TargetKind, "local">, TargetUrls> = {
  dev: {
    baseURL: "https://dev.aquilla.app",
    identityBase: "https://api.dev.aquilla.app/identity",
    syncBase: "https://api.dev.aquilla.app/sync",
  },
  "prod-canary": {
    baseURL: "https://aquilla.app",
    identityBase: "https://api.aquilla.app/identity",
    syncBase: "https://api.aquilla.app/sync",
  },
}

export function targetKind(env: NodeJS.ProcessEnv): TargetKind {
  const kind = env.ADVERSARIAL_TARGET ?? "local"
  if (kind !== "local" && kind !== "dev" && kind !== "prod-canary") {
    throw new Error(`Unknown ADVERSARIAL_TARGET "${kind}"; use local, dev, or prod-canary`)
  }
  return kind
}

/** The env the shared e2e helpers read, for one deployed target. */
export function targetEnv(kind: Exclude<TargetKind, "local">): Record<string, string> {
  const urls = DEPLOYED[kind]
  return {
    E2E_BASE_URL: urls.baseURL,
    VITE_FRONTIER_BASE: urls.identityBase,
    E2E_SYNC_BASE: urls.syncBase,
  }
}

export function targetUrls(env: NodeJS.ProcessEnv): TargetUrls {
  return {
    baseURL: env.E2E_BASE_URL ?? "",
    identityBase: env.VITE_FRONTIER_BASE ?? "",
    syncBase: env.E2E_SYNC_BASE ?? `http://${env.VITE_SYNC_WORKER_HOST ?? ""}`,
  }
}

/**
 * Refuse any host that is not the owned local stack or the exact deployed
 * host for the chosen kind. Production is reachable only as prod-canary,
 * and prod-canary never runs attacks (see `attacksAllowed`).
 */
export function assertAdversarialTarget(env: NodeJS.ProcessEnv): TargetKind {
  const kind = targetKind(env)
  const urls = targetUrls(env)
  if (kind === "local") {
    for (const url of Object.values(urls)) {
      const parsed = new URL(url || "http://missing")
      if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
        throw new Error(`Local adversarial runs must stay on 127.0.0.1, not ${parsed.host}`)
      }
    }
    const database = new URL(env.E2E_DATABASE_URL ?? "http://missing")
    if (!["localhost", "127.0.0.1"].includes(database.hostname)
      || !/^\/aquilla_e2e(?:_s\d+)?$/.test(database.pathname)) {
      throw new Error("Local adversarial runs require the isolated scripts/e2e-up.ts database")
    }
    return kind
  }
  const expected = DEPLOYED[kind]
  for (const key of Object.keys(expected) as (keyof TargetUrls)[]) {
    if (urls[key] !== expected[key]) {
      throw new Error(`${kind} target expects ${key}=${expected[key]}, got ${urls[key] || "nothing"}`)
    }
  }
  return kind
}

/** Only the model-free canary ever touches production. */
export const attacksAllowed = (kind: TargetKind) => kind !== "prod-canary"

export interface AdversarialUser { username: string; password: string }

/** `ADVERSARIAL_USER_1..3` as `username:password`; local falls back to the e2e seed users. */
export function adversarialUsers(env: NodeJS.ProcessEnv, kind: TargetKind): AdversarialUser[] {
  const fallback = ["alice:alice-test-pw", "bob:bob-test-pw", "carol:carol-test-pw"]
  return [1, 2, 3].map((n, index) => {
    const raw = env[`ADVERSARIAL_USER_${n}`] ?? (kind === "local" ? fallback[index] : undefined)
    const split = raw?.indexOf(":") ?? -1
    if (!raw || split < 1) throw new Error(`Set ADVERSARIAL_USER_${n}=username:password`)
    return { username: raw.slice(0, split), password: raw.slice(split + 1) }
  })
}
