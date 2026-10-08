import { describe, it, expect } from "vitest"
import { ROLE } from "@/lib/sync/role-policy"
import { TOOL_CSP, TOOL_SANDBOX, buildToolSrcdoc, embedJson } from "../srcdoc"
import { applyPromptAnswer, decideScope, grantableAtInstall, revokeScope } from "../permissions"
import type { ToolScope } from "../../../../shared/tools/manifest"

const BOOT = {
  tool: { id: "t", name: "T", version: 1 },
  project: { id: "p", name: "P" },
  user: { username: "u", roleLevel: 400 },
  mount: "page" as const,
  theme: {},
}

describe("embedJson", () => {
  it("cannot break out of an inline script and round-trips exactly", () => {
    const nasty = { s: "</script><script>alert(1)</script><!-- & \u2028\u2029 >" }
    const out = embedJson(nasty)
    expect(out).not.toMatch(/[<>&\u2028\u2029]/)
    expect(JSON.parse(out)).toEqual(nasty)
    // Evaluated as a JS expression (how the srcdoc uses it) it is identical too.
    expect(new Function(`return ${out}`)()).toEqual(nasty)
  })
})

describe("buildToolSrcdoc", () => {
  it("puts the CSP, boot data and runtime before any tool code", () => {
    const doc = buildToolSrcdoc(`<!doctype html><html><head><title>x</title></head><body><script>tool()</script></body></html>`, BOOT)
    const csp = doc.indexOf(TOOL_CSP)
    const runtime = doc.indexOf("aquilla-tool")
    const tool = doc.indexOf("tool()")
    expect(csp).toBeGreaterThan(0)
    expect(csp).toBeLessThan(runtime)
    expect(runtime).toBeLessThan(tool)
    expect(TOOL_CSP).toContain("connect-src 'none'")
    expect(TOOL_CSP).toContain("default-src 'none'")
    expect(TOOL_CSP).toContain("form-action 'none'")
    expect(TOOL_SANDBOX.split(" ")).not.toContain("allow-same-origin")
  })

  it("wraps a bare fragment in a full document", () => {
    const doc = buildToolSrcdoc(`<div>hi</div><script>x()</script>`, BOOT)
    expect(doc.startsWith("<!doctype html><html><head>")).toBe(true)
    expect(doc).toContain("<body><div>hi</div>")
  })
})

describe("permissions", () => {
  const state = (standing: ToolScope[], roleLevel: number | null, denied: ToolScope[] = []) => ({
    standing: new Set(standing),
    deniedThisSession: new Set(denied),
    roleLevel,
  })

  it("allows standing scopes, prompts for the rest, remembers a deny", () => {
    expect(decideScope("read:cells", state(["read:cells"], ROLE.CONTRIBUTOR))).toEqual({ kind: "allow" })
    expect(decideScope("write:target", state(["read:cells"], ROLE.CONTRIBUTOR))).toEqual({ kind: "prompt" })
    expect(decideScope("write:target", state([], ROLE.CONTRIBUTOR, ["write:target"]))).toEqual({ kind: "deny", reason: "denied" })
    expect(decideScope("write:everything", state([], ROLE.OWNER))).toEqual({ kind: "deny", reason: "unknown-scope" })
  })

  it("never exceeds the user's role, even with a standing grant", () => {
    expect(decideScope("write:target", state(["write:target"], ROLE.VIEWER))).toEqual({ kind: "deny", reason: "role" })
    expect(decideScope("read:cells", state(["read:cells"], ROLE.VIEWER))).toEqual({ kind: "allow" })
    const { grantable, blocked } = grantableAtInstall(["read:cells", "write:target"], ROLE.VIEWER)
    expect(grantable).toEqual(["read:cells"])
    expect(blocked).toEqual(["write:target"])
  })

  it("folds prompt answers: once / always / deny", () => {
    const standing = new Set<ToolScope>(["read:cells"])
    expect(applyPromptAnswer("write:target", "once", standing)).toEqual({ allowed: true, nextStanding: null, deny: null })
    expect(applyPromptAnswer("write:target", "always", standing)).toEqual({
      allowed: true,
      nextStanding: ["read:cells", "write:target"],
      deny: null,
    })
    expect(applyPromptAnswer("write:target", "deny", standing)).toEqual({ allowed: false, nextStanding: null, deny: "write:target" })
    expect(revokeScope(["read:cells", "write:target"], "write:target")).toEqual(["read:cells"])
  })
})
