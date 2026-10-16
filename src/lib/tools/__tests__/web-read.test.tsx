import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { toolCodeHash, validateManifest } from "../../../../shared/tools/manifest"
import { hostAllowed, validateWebDomain } from "../../../../shared/tools/web-domains"
import { lintToolSource } from "../../../../shared/tools/lint"
import { createToolHandlers } from "../host-handlers"
import { METHOD_SCOPES, grantableAtInstall } from "../permissions"
import { defaultSmokeFixtures } from "../smoke"
import { PermissionPrompt } from "@/components/tools/PermissionPrompt"

/** read:web (apiRev 6): the manifest's site list, the bridge call and the prompt. */

const base = { name: "Tracks", description: "", mounts: ["page"], apiRev: 6 }

describe("manifest.web", () => {
  it("accepts host names and a leading *. wildcard; normalizes case and duplicates", () => {
    const v = validateManifest({ ...base, scopes: ["read:web"], web: ["Git.Door43.org", "git.door43.org", "*.unfoldingword.org"] })
    expect(v.errors).toEqual([])
    expect(v.manifest?.web).toEqual(["git.door43.org", "*.unfoldingword.org"])
  })

  it.each([
    ["https://git.door43.org", "plain host name"],
    ["git.door43.org/path", "plain host name"],
    ["*.org", "not a valid host name"],
    ["*", "plain host name"],
    ["10.0.0.1", "top-level domain"],
    ["localhost", "not a valid host name"],
    ["api.internal", "local and internal"],
    ["a.b.local", "local and internal"],
    ["git.*.org", "plain host name"],
  ])("refuses %s", (domain, why) => {
    const v = validateWebDomain(domain)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toContain(why)
  })

  it("read:web needs a site list, a site list needs read:web, and both need apiRev 6", () => {
    expect(validateManifest({ ...base, scopes: ["read:web"] }).errors.join()).toMatch(/needs manifest\.web/)
    expect(validateManifest({ ...base, scopes: [], web: ["git.door43.org"] }).errors.join()).toMatch(/only allowed with the read:web scope/)
    expect(validateManifest({ ...base, apiRev: 5, scopes: ["read:web"], web: ["git.door43.org"] }).errors.join()).toMatch(/apiRev 6/)
  })

  it("the site list is part of the code hash; a tool without one keeps its old hash", async () => {
    const m = { ...base, scopes: ["read:web" as const], mounts: ["page" as const], web: ["git.door43.org"] }
    const other = await toolCodeHash("<p/>", { ...m, web: ["evil.org"] })
    expect(await toolCodeHash("<p/>", m)).not.toBe(other)
    const plain = { ...base, scopes: [], mounts: ["page" as const] }
    expect(await toolCodeHash("<p/>", plain)).toBe(await toolCodeHash("<p/>", { ...plain, web: [] }))
  })

  it("hostAllowed: exact names, and *. covers subdomains only", () => {
    expect(hostAllowed("git.door43.org", ["git.door43.org"])).toBe(true)
    expect(hostAllowed("cdn.door43.org", ["*.door43.org"])).toBe(true)
    expect(hostAllowed("door43.org", ["*.door43.org"])).toBe(false)
    expect(hostAllowed("evildoor43.org", ["*.door43.org"])).toBe(false)
  })
})

describe("bridge plumbing", () => {
  it("the lint lets aquilla.web.fetch through and still bans every other fetch", () => {
    expect(lintToolSource("<script>aquilla.web.fetch('https://example.org/x')</script>").ok).toBe(true)
    for (const src of ["fetch('/x')", "window.fetch('/x')", "globalThis.fetch('/x')", "self.fetch ('/x')"]) expect(lintToolSource(`<script>${src}</script>`).ok, src).toBe(false)
  })

  it("web.fetch is gated by read:web and never granted silently at install", () => {
    expect(METHOD_SCOPES["web.fetch"]).toBe("read:web")
    // Reads are granted at install by the page; read:web is filtered out there (ToolsPage) and prompts instead.
    expect(grantableAtInstall(["read:cells", "read:web"], 700).grantable).toContain("read:web")
  })

  it("the handler validates the URL and hands it to the host data with the requested format", async () => {
    const data = defaultSmokeFixtures({ name: "x", description: "", scopes: ["read:web"], mounts: ["page"], apiRev: 6, web: ["git.door43.org"] })[1].data
    const spy = vi.spyOn(data, "webFetch")
    const handlers = createToolHandlers(data)
    await expect(handlers["web.fetch"]({ url: "  https://git.door43.org/x  ", as: "json" })).resolves.toMatchObject({ status: 200, body: [] })
    expect(spy).toHaveBeenCalledWith("https://git.door43.org/x", "json")
    await expect(handlers["web.fetch"]({ url: "" })).rejects.toMatchObject({ code: "invalid_params" })
    await expect(handlers["web.fetch"]({ url: `https://git.door43.org/${"a".repeat(2100)}` })).rejects.toMatchObject({ code: "invalid_params" })
  })
})

describe("the permission prompt names the site", () => {
  it("says who wants to read what, that the site sees the request, and offers no Allow once", () => {
    const answer = vi.fn()
    render(<PermissionPrompt toolName="Verse Tracks" prompt={{ scope: "read:web", declared: true, answer }} web={["git.door43.org"]} />)
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Verse Tracks wants to read from git.door43.org.")
    expect(screen.getByRole("alertdialog")).toHaveTextContent("The site can see what this extension asks it for.")
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()
    screen.getByRole("button", { name: "Always allow" }).click()
    expect(answer).toHaveBeenCalledWith("always")
  })
})
