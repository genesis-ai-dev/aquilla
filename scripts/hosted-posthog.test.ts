import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { hostedPosthog, hostedPosthogEnv } from "./hosted-posthog.mjs"
import { resolvePosthogHost } from "../src/lib/posthog-host"
import { shipLog as shipIdentityLog } from "../auth-worker/src/posthog-logs"
import { shipLog as shipSyncLog } from "../sync-worker/src/posthog-logs"
import { shipLog as shipAgentLog } from "../agent-worker/src/posthog-logs"

describe("hosted EU PostHog connection (AQU-1814)", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("passes the hosted build environment through browser host resolution", () => {
    const original = {
      VITE_AUTH_BASE: "https://api.dev.aquilla.app/identity",
      VITE_POSTHOG_KEY: "retired-project",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    }
    const env = hostedPosthogEnv(original)
    expect(hostedPosthog.projectId).toBe(282623)
    expect(env.VITE_POSTHOG_KEY).toBe(hostedPosthog.projectToken)
    expect(resolvePosthogHost(env.VITE_POSTHOG_HOST))
      .toBe("https://eu.i.posthog.com")
    expect(env.VITE_AUTH_BASE).toBe(original.VITE_AUTH_BASE)
    expect(original.VITE_POSTHOG_KEY).toBe("retired-project")
  })

  it.each([
    ["auth-worker", shipIdentityLog],
    ["sync-worker", shipSyncLog],
    ["agent-worker", shipAgentLog],
  ] as const)("%s live config reaches the real EU log shipper", async (
    directory, shipLog,
  ) => {
    const config = readFileSync(path.resolve(
      import.meta.dirname, `../${directory}/wrangler.toml`,
    ), "utf8")
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetch)

    for (const profile of ["production", "development"]) {
      const section = config.split(`[env.${profile}.vars]\n`)[1]
        ?.split(/\n\[/)[0]
      expect(section, `${directory} ${profile} vars`).toBeDefined()
      const env = Object.fromEntries([...section!.matchAll(
        /^(POSTHOG_(?:HOST|KEY)) = "([^"]*)"$/gm,
      )].map((match) => [match[1], match[2]]))
      expect(env.POSTHOG_KEY).toBe(hostedPosthog.projectToken)
      expect(env.POSTHOG_HOST).toBe(hostedPosthog.ingestHost)
      await shipLog(env, directory, "info", "connection regression test")
      expect(fetch).toHaveBeenLastCalledWith(
        "https://eu.i.posthog.com/i/v1/logs",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${hostedPosthog.projectToken}`,
          }),
        }),
      )
    }
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
