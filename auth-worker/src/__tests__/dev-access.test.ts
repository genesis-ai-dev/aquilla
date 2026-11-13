// AQU-2469: only people on the access list can use dev.aquilla.app.
//
// The gate turns on when DEPLOYMENT_WORKER_NAME is the development identity
// Worker; each test flips that on and binds an in-memory KV. "root"
// (root@example.com) is the test platform admin via ADMIN_EMAILS.

import { env as testEnv } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import app from "../index"
import type { Env } from "../types"
import { hashPasswordWerkzeugScrypt } from "../utils/password"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { checkDevAccess, DEV_IDENTITY_WORKER } from "../services/dev-access"

const env = testEnv as unknown as Env

/** Just enough of KVNamespace for get/put/delete/list. */
class MemoryKV {
  store = new Map<string, { value: string; metadata: unknown }>()
  failReads = false
  async get(key: string): Promise<string | null> {
    if (this.failReads) throw new Error("kv down")
    return this.store.get(key)?.value ?? null
  }
  async put(key: string, value: string, opts?: { metadata?: unknown }): Promise<void> {
    this.store.set(key, { value, metadata: opts?.metadata ?? null })
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
  async list() {
    return {
      keys: [...this.store].map(([name, v]) => ({ name, metadata: v.metadata })),
      list_complete: true,
      cursor: "",
    }
  }
}

let kv: MemoryKV

const onDev = () => {
  env.DEPLOYMENT_WORKER_NAME = DEV_IDENTITY_WORKER
  env.DEV_ACCESS_LIST = kv as unknown as KVNamespace
}

beforeEach(() => {
  kv = new MemoryKV()
})
afterEach(() => {
  env.DEPLOYMENT_WORKER_NAME = undefined
  env.DEV_ACCESS_LIST = undefined
})

const usersMe = (jwt: string) => app.request("/api/v2/auth/me", { headers: authHeader(jwt) }, env)
const login = (username: string, password: string) =>
  app.request(
    "/api/v2/auth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    },
    env,
  )

async function seedWithPassword(id: number, username: string, password: string) {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO users (id, username, email, password_hash, preferences) VALUES (?, ?, ?, ?, '{}')",
  )
    .bind(id, username, `${username}@example.com`, await hashPasswordWerkzeugScrypt(password))
    .run()
}

describe("where the gate runs", () => {
  it("is off on production and local, whatever the list says", async () => {
    for (const name of [undefined, "aquilla-identity", "aquilla-identity-local"]) {
      env.DEPLOYMENT_WORKER_NAME = name
      expect(await checkDevAccess(env, "stranger@example.com")).toEqual({ allowed: true })
    }
  })

  it("requires explicit dev access for a preview-only bootstrap admin", async () => {
    env.DEPLOYMENT_WORKER_NAME = "aquilla-auth-preview"
    env.DEV_ACCESS_LIST = kv as unknown as KVNamespace
    await seedUser(1, "root")
    const jwt = await jwtFor("root")
    expect((await usersMe(jwt)).status).toBe(403)
    await kv.put("root@example.com", "{}")
    expect((await usersMe(jwt)).status).toBe(200)
    await kv.delete("root@example.com")
    expect((await usersMe(jwt)).status).toBe(403)
  })

  it("leaves a stranger's API calls alone off dev", async () => {
    await seedUser(2, "wendi")
    env.DEPLOYMENT_WORKER_NAME = "aquilla-identity"
    expect((await usersMe(await jwtFor("wendi"))).status).toBe(200)
  })
})

describe.each([DEV_IDENTITY_WORKER, "aquilla-auth-preview"])("API requests on %s", (worker) => {
  beforeEach(async () => {
    onDev(); env.DEPLOYMENT_WORKER_NAME = worker
    if (worker === "aquilla-auth-preview")
      await env.AQUILLA_PG.prepare("INSERT INTO platform_admins(email) VALUES ('root@example.com')").run()
  })

  it("refuses an account that is not on the list, with a plain message", async () => {
    await seedUser(2, "wendi")
    const res = await usersMe(await jwtFor("wendi"))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe("dev_access_restricted")
    expect(body.error).toBe(
      worker === "aquilla-auth-preview"
        ? "Access to CI previews is restricted. Ask the Aquilla team to add you to the dev access list."
        : "Access to dev is restricted. Ask the Aquilla team to add you to the dev access list.",
    )
  })

  it("lets a listed account through, matching the email case-insensitively", async () => {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO users (id, username, email, password_hash, preferences) VALUES (3, 'qa', 'QA-Bot@Example.com', 'x', '{}')",
    ).run()
    await kv.put("qa-bot@example.com", "{}")
    expect((await usersMe(await jwtFor("qa"))).status).toBe(200)
  })

  it("lets a platform admin through without a list entry", async () => {
    await seedUser(1, "root")
    expect((await usersMe(await jwtFor("root"))).status).toBe(200)
  })

  it("lets an admin from the platform_admins table through", async () => {
    await seedUser(4, "tabby")
    await env.AQUILLA_PG.prepare("INSERT INTO platform_admins (email) VALUES ('tabby@example.com')").run()
    expect((await usersMe(await jwtFor("tabby"))).status).toBe(200)
  })

  it("refuses again as soon as the entry is removed", async () => {
    await seedUser(2, "wendi")
    await kv.put("wendi@example.com", "{}")
    const jwt = await jwtFor("wendi")
    expect((await usersMe(jwt)).status).toBe(200)
    await kv.delete("wendi@example.com")
    expect((await usersMe(jwt)).status).toBe(403)
  })

  it("fails closed when the list cannot be read", async () => {
    await seedUser(2, "wendi")
    await kv.put("wendi@example.com", "{}")
    kv.failReads = true
    expect((await usersMe(await jwtFor("wendi"))).status).toBe(503)
  })

  it("fails closed when the binding is missing, but still admits admins", async () => {
    env.DEV_ACCESS_LIST = undefined
    await seedUser(1, "root")
    await seedUser(2, "wendi")
    expect((await usersMe(await jwtFor("wendi"))).status).toBe(503)
    expect((await usersMe(await jwtFor("root"))).status).toBe(200)
  })

  it("refuses a sync token for an account not on the list", async () => {
    await seedUser(2, "wendi")
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: authHeader(await jwtFor("wendi")),
        body: JSON.stringify({ projectId: "p1", fileId: "f1" }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })
})

describe.each([DEV_IDENTITY_WORKER, "aquilla-auth-preview"])("sign-in and sign-up on %s", (worker) => {
  beforeEach(async () => {
    onDev(); env.DEPLOYMENT_WORKER_NAME = worker
    if (worker === "aquilla-auth-preview")
      await env.AQUILLA_PG.prepare("INSERT INTO platform_admins(email) VALUES ('root@example.com')").run()
  })

  it("refuses a correct password from an account not on the list", async () => {
    await seedWithPassword(2, "wendi", "right-password")
    const res = await login("wendi", "right-password")
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("dev_access_restricted")
  })

  it("answers a wrong password with the usual 401, so the list is not revealed", async () => {
    await seedWithPassword(2, "wendi", "right-password")
    expect((await login("wendi", "wrong-password")).status).toBe(401)
  })

  it("signs in a listed account", async () => {
    await seedWithPassword(2, "wendi", "right-password")
    await kv.put("wendi@example.com", "{}")
    expect((await login("wendi", "right-password")).status).toBe(200)
  })

  it("refuses to create an account for an email not on the list", async () => {
    const res = await app.request(
      "/api/v2/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "newbie", email: "new@example.com", password: "very-secure" }),
      },
      env,
    )
    expect(res.status).toBe(403)
    const row = await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM users WHERE username = 'newbie'").first()
    expect(row).toBeNull()
  })
})

describe("Admin → Platform → Dev access", () => {
  const list = (jwt: string) => app.request("/api/v2/admin/dev-access", { headers: authHeader(jwt) }, env)
  const add = (jwt: string, email: string) =>
    app.request(
      "/api/v2/admin/dev-access",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ email }) },
      env,
    )
  const remove = (jwt: string, email: string) =>
    app.request(
      `/api/v2/admin/dev-access/${encodeURIComponent(email)}`,
      { method: "DELETE", headers: authHeader(jwt) },
      env,
    )

  it("reports the list as off outside dev and refuses writes there", async () => {
    await seedUser(1, "root")
    const jwt = await jwtFor("root")
    expect(await (await list(jwt)).json()).toEqual({ enabled: false, entries: [] })
    expect((await add(jwt, "x@example.com")).status).toBe(409)
  })

  it("adds and removes an email, and the change takes effect without a deploy", async () => {
    onDev()
    await seedUser(1, "root")
    await seedUser(2, "wendi")
    const admin = await jwtFor("root")
    const wendi = await jwtFor("wendi")
    expect((await usersMe(wendi)).status).toBe(403)

    const added = await add(admin, "  Wendi@Example.com ")
    expect(added.status).toBe(201)
    expect((await usersMe(wendi)).status).toBe(200)

    const body = (await (await list(admin)).json()) as { enabled: boolean; entries: { email: string; addedBy: string }[] }
    expect(body.enabled).toBe(true)
    expect(body.entries).toEqual([expect.objectContaining({ email: "wendi@example.com", addedBy: "root@example.com" })])

    expect((await remove(admin, "wendi@example.com")).status).toBe(200)
    expect((await usersMe(wendi)).status).toBe(403)

    const audit = await env.AQUILLA_PG.prepare(
      "SELECT action FROM admin_audit_log WHERE action LIKE 'dev_access.%' ORDER BY id",
    ).all<{ action: string }>()
    expect(audit.results.map((r) => r.action)).toEqual(["dev_access.add", "dev_access.remove"])
  })

  it("rejects a malformed email", async () => {
    onDev()
    await seedUser(1, "root")
    expect((await add(await jwtFor("root"), "not-an-email")).status).toBe(400)
  })

  it("is closed to people who are not platform admins", async () => {
    onDev()
    await seedUser(2, "wendi")
    await kv.put("wendi@example.com", "{}")
    expect((await list(await jwtFor("wendi"))).status).toBe(403)
  })
})
