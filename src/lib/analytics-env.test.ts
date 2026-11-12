import { describe, expect, it } from "vitest"
import { resolveAppEnv } from "./analytics-env"

const env = (href: string) => resolveAppEnv(new URL(href))

// AQU-1572: one PostHog key serves every build, so `app_env` is the only way a
// dashboard can tell a translator's session from a developer's. These pin the
// hostname → environment map to the hosts the repo actually deploys to.
describe("resolveAppEnv (AQU-1572)", () => {
  it("maps the canonical production host, including the planned app subdomain", () => {
    expect(env("https://aquilla.app/project/abc/editor")).toBe("production")
    expect(env("https://app.aquilla.app/app")).toBe("production")
  })

  it("maps the dev deployment", () => {
    expect(env("https://dev.aquilla.app/app")).toBe("dev")
  })

  it("does not mistake a sibling subdomain for production or dev", () => {
    // docs., api., and retired hosts never serve the SPA as production; if one
    // ever does, it shows up as "preview" rather than inflating production.
    expect(env("https://docs.aquilla.app/")).toBe("preview")
    expect(env("https://web.aquilla.app/app")).toBe("preview")
    expect(env("https://staging.aquilla.app/app")).toBe("preview")
    expect(env("https://aquilla.app.evil.example/app")).toBe("preview")
  })

  it("classes PR previews, version previews and legacy Pages deploys as preview", () => {
    expect(env("https://pr-274-aquilla-web-preview.blue-darkness-7674.workers.dev/app")).toBe("preview")
    expect(env("https://a66aa4e6-aquilla-web.blue-darkness-7674.workers.dev/app")).toBe("preview")
    expect(env("https://4d61d571-aquilla-web-development.blue-darkness-7674.workers.dev/")).toBe("preview")
    expect(env("https://codex-web.pages.dev/")).toBe("preview")
  })

  it("classes every loopback and wildcard-bind dev server as local", () => {
    for (const href of [
      "http://localhost:5173/app",
      "http://127.0.0.1:5173/app",
      "http://127.0.1.1:4173/",
      "http://[::1]:5173/app",
      "http://0.0.0.0:5173/app",
      "http://aquilla.localhost:5173/app",
      // The Tauri shell's dev mode loads the Vite server (devUrl) — still a dev build.
      "http://127.0.0.1:1420/app",
    ]) {
      expect(env(href), href).toBe("local")
    }
  })

  it("accepts a bare IPv6 loopback hostname as well as the bracketed form", () => {
    expect(resolveAppEnv({ protocol: "http:", hostname: "::1" })).toBe("local")
    expect(resolveAppEnv({ protocol: "http:", hostname: "[::1]" })).toBe("local")
  })

  it("treats the Tauri desktop shell as desktop even though it looks like localhost", () => {
    expect(env("tauri://localhost/app")).toBe("desktop")
    expect(env("http://tauri.localhost/app")).toBe("desktop")
    expect(env("https://tauri.localhost/app")).toBe("desktop")
  })

  it("is case-insensitive", () => {
    expect(resolveAppEnv({ protocol: "HTTPS:", hostname: "Aquilla.App" })).toBe("production")
    expect(resolveAppEnv({ protocol: "TAURI:", hostname: "localhost" })).toBe("desktop")
  })
})
