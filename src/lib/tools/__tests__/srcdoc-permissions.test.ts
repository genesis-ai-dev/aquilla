import { describe, it, expect } from "vitest"
import { ROLE } from "@/lib/sync/role-policy"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { TOOL_CSP, TOOL_SANDBOX, TOOL_SHELL_CSP, buildToolShellSrcdoc, buildToolSrcdoc, embedJson, toolWindowOf } from "../srcdoc"
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

// A sandboxed frame may navigate itself, and only its EMBEDDER's frame-src can
// refuse that. So a tool document is never mounted directly: see TOOL_SHELL_CSP.
describe("the shell frame around every tool", () => {
  it("forbids every navigation of the tool frame, holds the tool document intact and runs nothing itself", () => {
    expect(TOOL_SHELL_CSP).toContain("frame-src 'none'")
    // Nothing looser than the tool: a srcdoc document inherits its embedder's policy.
    expect(TOOL_SHELL_CSP.startsWith(TOOL_CSP)).toBe(true)

    const tool = buildToolSrcdoc(`<p title='a "quoted" &amp; &quot;escaped&quot; value'>x</p></iframe><script>tool("</iframe>")</script>`, BOOT)
    const shell = new DOMParser().parseFromString(buildToolShellSrcdoc(tool, `Notes "Reader" & co`), "text/html")
    const frames = shell.querySelectorAll("iframe")
    expect(frames).toHaveLength(1)
    expect(frames[0].getAttribute("srcdoc")).toBe(tool)
    expect(frames[0].getAttribute("title")).toBe(`Notes "Reader" & co`)
    expect(frames[0].getAttribute("sandbox")).toBe(TOOL_SANDBOX)
    expect(shell.querySelectorAll("script")).toHaveLength(0)
    const csp = shell.querySelector("meta[http-equiv=Content-Security-Policy]")
    expect(csp?.getAttribute("content")).toBe(TOOL_SHELL_CSP)
    // The policy is in force before the frame it governs exists.
    expect(csp && frames[0].compareDocumentPosition(csp) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it("the tool's window is the shell's only child, and nothing before the shell has parsed", () => {
    const toolWindow = { tool: true }
    const frame = (contentWindow: unknown) => ({ contentWindow }) as unknown as HTMLIFrameElement
    expect(toolWindowOf(frame({ 0: toolWindow }))).toBe(toolWindow)
    expect(toolWindowOf(frame({}))).toBeNull()
    expect(toolWindowOf(frame(null))).toBeNull()
    expect(toolWindowOf(null)).toBeNull()
  })

  it("every module that sandboxes a tool frame mounts it through the shell and reads the tool's window through it", () => {
    const root = path.resolve(__dirname, "../../..")
    const sources: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name)
        if (statSync(file).isDirectory()) walk(file)
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) sources.push(file)
      }
    }
    walk(root)
    const mounting = sources.filter((file) => /sandbox=\{TOOL_SANDBOX\}|setAttribute\("sandbox", TOOL_SANDBOX\)/.test(readFileSync(file, "utf8")))
    expect(mounting.length).toBeGreaterThanOrEqual(4)
    for (const file of mounting) {
      const source = readFileSync(file, "utf8")
      const where = path.relative(root, file)
      expect(source, `${where} must mount buildToolShellSrcdoc(...), never a tool document directly`).toMatch(/buildToolShellSrcdoc\(/)
      expect(source, `${where}: a frame's own contentWindow is the shell; use toolWindowOf`).not.toMatch(/\.contentWindow\b/)
    }
    // The hook the mounts share is where the bridge finds the tool's window.
    expect(readFileSync(path.join(root, "components/tools/useToolHost.ts"), "utf8")).not.toMatch(/\.contentWindow\b/)
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
