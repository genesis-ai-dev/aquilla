// Global platform settings via the admin console (GET/PATCH /api/v2/admin/settings)
// and proof that the store overrides the env default on the chat hot path.
//
// ADMIN_EMAILS is pinned to "root@example.com" (pg-test-env), so "root" is the
// admin. ADMIN_REQUIRE_ELEVATION is unset here, so no step-up is needed —
// exercising the settings routes directly. The elevation flow has its own suite.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { resolveContextualModels } from "../lib/contextual/tick"
import { getPlatformSettingsCached } from "../lib/platform-settings"

const get = (jwt: string) =>
  app.request("/api/v2/admin/settings", { headers: authHeader(jwt) }, env)

const patch = (jwt: string, body: Record<string, unknown>) =>
  app.request(
    "/api/v2/admin/settings",
    { method: "PATCH", headers: authHeader(jwt), body: JSON.stringify(body) },
    env,
  )

afterEach(() => {
  vi.restoreAllMocks()
})

describe("GET/PATCH /api/v2/admin/settings", () => {
  it("non-admin is rejected (403)", async () => {
    await seedUser(1, "wendi")
    const res = await patch(await jwtFor("wendi"), { defaultLlmModel: "x", ifMatchVersion: 0 })
    expect(res.status).toBe(403)
  })

  it("GET returns empty defaults + the effective env-fallback model", async () => {
    await seedUser(7, "root")
    const res = await get(await jwtFor("root"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      settings: Record<string, unknown>
      version: number
      effective: { defaultLlmModel: string; allowedModels: string[] }
    }
    expect(body.version).toBe(0)
    expect(body.settings).toEqual({})
    // env DEFAULT_LLM_MODEL in pg-test-env.
    expect(body.effective.defaultLlmModel).toBe("openai/gpt-5.6-luna")
    expect(body.effective.allowedModels).toContain("openai/gpt-5.6-luna")
  })

  it("PATCH sets an allowed model and GET reflects it (version bumps)", async () => {
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    const res = await patch(jwt, { defaultLlmModel: "anthropic/claude-haiku-4-5", ifMatchVersion: 0 })
    expect(res.status).toBe(200)
    const saved = (await res.json()) as { settings: { defaultLlmModel: string }; version: number }
    expect(saved.settings.defaultLlmModel).toBe("anthropic/claude-haiku-4-5")
    expect(saved.version).toBe(1)

    const after = (await (await get(jwt)).json()) as {
      settings: { defaultLlmModel: string }
      version: number
    }
    expect(after.settings.defaultLlmModel).toBe("anthropic/claude-haiku-4-5")
    expect(after.version).toBe(1)
  })

  it("PATCH rejects a model not in the allowed list (400)", async () => {
    await seedUser(7, "root")
    const res = await patch(await jwtFor("root"), {
      defaultLlmModel: "openai/gpt-4o-ultra",
      ifMatchVersion: 0,
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: "model_not_allowed" })
  })

  it("PATCH accepts a custom model once it's added to allowedModels in the same patch", async () => {
    await seedUser(7, "root")
    const res = await patch(await jwtFor("root"), {
      allowedModels: ["anthropic/claude-sonnet-4.5", "anthropic/claude-opus-4-1"],
      defaultLlmModel: "anthropic/claude-opus-4-1",
      ifMatchVersion: 0,
    })
    expect(res.status).toBe(200)
  })

  it("returns 409 on a version mismatch", async () => {
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    await patch(jwt, { aiUserDailyLimit: 100, ifMatchVersion: 0 }) // → version 1
    const stale = await patch(jwt, { aiUserDailyLimit: 200, ifMatchVersion: 0 }) // stale
    expect(stale.status).toBe(409)
  })

  it("records an audit-log row on a settings change", async () => {
    await seedUser(7, "root")
    await patch(await jwtFor("root"), { aiBudgetEnforce: true, ifMatchVersion: 0 })
    const row = await env.AQUILLA_PG.prepare(
      "SELECT action FROM admin_audit_log WHERE action = 'settings.update'",
    ).first<{ action: string }>()
    expect(row?.action).toBe("settings.update")
  })
})

describe("platform_settings overrides the env default on the chat hot path", () => {
  it("GET reports the autopilot tiers as they actually resolve, fallback included", async () => {
    await seedUser(7, "root")
    const body = (await (await get(await jwtFor("root"))).json()) as {
      effective: { contextualFastModel: string; contextualDeepModel: string }
    }
    // Nothing stored and no CONTEXTUAL_* env in pg-test-env: every tier lands
    // on the one frontier model. Showing an empty field here would hide that.
    expect(body.effective.contextualFastModel).toBe("openai/gpt-5.6-luna")
    expect(body.effective.contextualDeepModel).toBe("openai/gpt-5.6-luna")
  })

  it("an admin-set fast tier reaches resolveContextualModels", async () => {
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    const res = await patch(jwt, {
      contextualFastModel: "anthropic/claude-haiku-4-5",
      ifMatchVersion: 0,
    })
    expect(res.status).toBe(200)

    const settings = await getPlatformSettingsCached(env)
    const models = resolveContextualModels(env, settings)
    expect(models.fast).toBe("anthropic/claude-haiku-4-5")
    // Setting one tier must not disturb the others.
    expect(models.mid).toBe("openai/gpt-5.6-luna")
    expect(models.deep).toBe("openai/gpt-5.6-luna")
  })

  it("an empty string CLEARS a tier back to the fallback", async () => {
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    await patch(jwt, { contextualFastModel: "anthropic/claude-haiku-4-5", ifMatchVersion: 0 })
    const cleared = await patch(jwt, { contextualFastModel: "", ifMatchVersion: 1 })
    expect(cleared.status).toBe(200)

    const body = (await (await get(jwt)).json()) as {
      settings: Record<string, unknown>
      effective: { contextualFastModel: string }
    }
    // Not stored as "" — the key is gone, so the env/default fallback resolves.
    expect(body.settings.contextualFastModel).toBeUndefined()
    expect(body.effective.contextualFastModel).toBe("openai/gpt-5.6-luna")
    expect(resolveContextualModels(env, await getPlatformSettingsCached(env)).fast).toBe(
      "openai/gpt-5.6-luna",
    )
  })

  it("PATCH rejects a tier that is not in the allowed list", async () => {
    await seedUser(7, "root")
    const res = await patch(await jwtFor("root"), {
      contextualFastModel: "some/unvetted-model",
      ifMatchVersion: 0,
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe("model_not_allowed")
    expect(body.message).toContain("contextualFastModel")
  })

  it("accepts a tier added to allowedModels in the same patch", async () => {
    await seedUser(7, "root")
    const res = await patch(await jwtFor("root"), {
      allowedModels: ["openai/gpt-5.6-luna", "vendor/tiny-fast"],
      contextualFastModel: "vendor/tiny-fast",
      ifMatchVersion: 0,
    })
    expect(res.status).toBe(200)
    expect(resolveContextualModels(env, await getPlatformSettingsCached(env)).fast).toBe(
      "vendor/tiny-fast",
    )
  })

  it("a stored tier beats the env var, which beats the default", () => {
    const envWith = { CONTEXTUAL_FAST_MODEL: "env/fast" }
    expect(resolveContextualModels(envWith, {}).fast).toBe("env/fast")
    expect(resolveContextualModels(envWith, { contextualFastModel: "store/fast" }).fast).toBe(
      "store/fast",
    )
    expect(resolveContextualModels({}, {}).fast).toBe("openai/gpt-5.6-luna")
  })

    it("a 'default' chat request uses the admin-set model", async () => {
    await seedUser(1, "wendi")
    await seedUser(7, "root")
    // Admin pins the default chat model to Haiku.
    const ok = await patch(await jwtFor("root"), {
      defaultLlmModel: "anthropic/claude-haiku-4-5",
      ifMatchVersion: 0,
    })
    expect(ok.status).toBe(200)

    // Capture the model forwarded to OpenRouter.
    let forwardedModel: string | null = null
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      forwardedModel = JSON.parse(String(init?.body)).model as string
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "OK", role: "assistant" } }], usage: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })

    const chatEnv = Object.assign(Object.create(env), { OPENROUTER_API_KEY: "test-key" })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: authHeader(await jwtFor("wendi")),
        body: JSON.stringify({ model: "default", messages: [{ role: "user", content: "hi" }], stream: false }),
      },
      chatEnv,
    )
    expect(res.status).toBe(200)
    expect(forwardedModel).toBe("anthropic/claude-haiku-4-5")
  })
})
