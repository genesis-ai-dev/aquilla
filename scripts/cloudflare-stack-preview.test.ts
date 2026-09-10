import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"
import { workersBuildPreviewAlias } from "./cloudflare-pr-preview.mjs"
import { deployStackPreview, previewConfig, previewOrigin, PREVIEW_WORKERS } from "./cloudflare-stack-preview.mjs"

const env = { WORKERS_CI: "1", WORKERS_CI_BRANCH: "feature/example", WORKERS_CI_COMMIT_SHA: "abc123", WRANGLER_CI_OVERRIDE_NAME: "aquilla-web-preview" }

const previewName = workersBuildPreviewAlias(env.WORKERS_CI_BRANCH)
const authOrigin = `https://${previewName}-aquilla-auth-preview.blue-darkness-7674.workers.dev`
const syncOrigin = `https://${previewName}-aquilla-sync-preview.blue-darkness-7674.workers.dev`

describe("full-stack Cloudflare previews", () => {
  it("connects Wrangler output to the frontend build and backend callbacks", async ({ onTestFinished }) => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "preview-ci-output-"))
    onTestFinished(() => rmSync(outputDirectory, { recursive: true, force: true }))
    const configs: Array<{ surface: string; config: any }> = []
    const run = vi.fn(async (_command: string, args: string[], options: any) => {
      if (args.includes("base-config")) {
        const config = JSON.parse(readFileSync(args[args.indexOf("--config") + 1], "utf8"))
        expect(options.env.WRANGLER_CI_OVERRIDE_NAME).toBe(config.name)
        return { stdout: JSON.stringify(["SECRET_KEY", "SYNC_SECRET_KEY", "ADMIN_SECRET"].map((name) => ({ name, type: "secret_text" }))) }
      }
      if (args[1] === "vite") {
        expect(options.env.VITE_AUTH_BASE).toBe(`${authOrigin}/identity`)
        expect(options.env.VITE_CHAT_BASE).toBe(`${authOrigin}/chat`)
        expect(options.env.VITE_SYNC_WORKER_HOST).toBe(`${new URL(syncOrigin).host}/sync`)
        return { stdout: "" }
      }
      expect(args.slice(0, 3)).toEqual(["exec", "wrangler", "preview"])
      const config = JSON.parse(readFileSync(args[args.indexOf("--config") + 1], "utf8"))
      const surface = Object.keys(PREVIEW_WORKERS).find((key) => PREVIEW_WORKERS[key] === config.name)!
      expect(options.env.WRANGLER_CI_OVERRIDE_NAME).toBe(config.name)
      configs.push({ surface, config })
      writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({
        type: "preview", preview_slug: previewName,
        preview_name: args[args.indexOf("--name") + 1],
        deployment_id: "deployment-123",
        preview_urls: [`https://${previewName}-${config.name}.blue-darkness-7674.workers.dev`],
      }) + "\n")
      return { stdout: "" }
    })
    const verify = vi.fn()
    const result = await deployStackPreview({ cwd: "/tmp/preview-contract-fixture", env: { ...env, WRANGLER_OUTPUT_FILE_DIRECTORY: outputDirectory }, run, verify })
    expect(configs.map(({ surface }) => surface)).toEqual(["auth", "sync", "web", "auth", "sync"])
    expect(configs[0].config.previews.vars.SYNC_WORKER_URL).toBe("https://preview-not-ready.invalid")
    expect(configs[3].config.previews.vars).toMatchObject({
      BASE_URL: result.urls.web, SYNC_WORKER_URL: `${result.urls.sync}/sync`,
    })
    expect(configs[4].config.previews.vars).toMatchObject({
      BASE_URL: result.urls.web, AUTH_WORKER_URL: `${result.urls.auth}/identity`,
    })
    expect(JSON.parse(readFileSync(join(outputDirectory, "wrangler-output-aquilla-preview.json"), "utf8"))).toMatchObject({
      type: "preview", worker_name: PREVIEW_WORKERS.web, preview_urls: [result.urls.web],
    })
    expect(verify).toHaveBeenCalledWith("/tmp/preview-contract-fixture/dist")
    expect(run.mock.calls.filter(([, args]) => args[1] === "vite")).toHaveLength(1)
  })

  it.each(["auth", "sync"])("keeps %s previews on development storage with no live routes or dev auth bypass", (surface) => {
    const config = previewConfig(surface, { cwd: "/repo" })
    expect(config.previews.hyperdrive).toEqual([{ binding: "HYPERDRIVE", id: "53581197ff7a4202a5ed0ef08537d4a6" }])
    expect(config.previews.r2_buckets).toEqual([{ binding: "SNAPSHOTS", bucket_name: "aquilla-snapshots-dev" }])
    expect(config).not.toHaveProperty("routes")
    expect(config).not.toHaveProperty("triggers")
    expect(config).not.toHaveProperty("build")
    expect(config.previews.vars).not.toHaveProperty("WRANGLER_LOCAL")
    expect(config.previews.vars).not.toHaveProperty("ALLOW_UNAUTHENTICATED")
    expect(JSON.stringify(config)).not.toContain("api.aquilla.app")
  })

  it("preserves the sync Durable Object migration history", () => {
    const config = previewConfig("sync", { cwd: "/repo" })
    expect(config.previews.durable_objects?.bindings).toEqual([{ name: "ProjectSync", class_name: "ProjectSync" }])
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["FileSync"] },
      { tag: "v2", new_sqlite_classes: ["ProjectSync"] },
    ])
  })

  it("stops before deploying anything without Cloudflare commit metadata", async () => {
    const run = vi.fn()
    await expect(deployStackPreview({ env: {}, run })).rejects.toThrow("WORKERS_CI=1")
    expect(run).not.toHaveBeenCalled()
  })

  it("does not publish a frontend after a failed backend deployment", async () => {
    const secrets = { stdout: JSON.stringify(["SECRET_KEY", "SYNC_SECRET_KEY", "ADMIN_SECRET"].map((name) => ({ name }))) }
    const run = vi.fn().mockResolvedValueOnce(secrets).mockResolvedValueOnce(secrets)
      .mockRejectedValue(new Error("backend upload failed"))
    await expect(deployStackPreview({ env, run })).rejects.toThrow("backend upload failed")
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("refuses to deploy a stack without its signing secrets", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "[]" })
    await expect(deployStackPreview({ env, run })).rejects.toThrow("Previews Base is missing")
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1]).toContain("base-config")
  })

  it("rejects missing URLs and mismatched Worker identities", () => {
    const entry = { worker_name: PREVIEW_WORKERS.auth, preview_name: "test", preview_slug: "test", deployment_id: "123", preview_urls: [] }
    expect(() => previewOrigin(entry, "auth", "test")).toThrow("Enable Preview")
    expect(() => previewOrigin(entry, "sync", "test")).toThrow("identity")
    expect(() => previewOrigin({ ...entry, preview_urls: ["https://api.aquilla.app"] }, "auth", "test")).toThrow("URL")
  })
})
