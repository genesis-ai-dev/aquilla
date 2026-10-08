/**
 * Capability twins: every bridge capability exists in each place that has to
 * agree on it — the in-frame runtime (what tools call), the host handlers
 * (what answers), the permission map (what gates it), the smoke stub (what
 * the builder's pre-save render answers with) and the builder's system prompt
 * (what the model is told exists). A capability added to one and not the
 * others is a tool that builds but fails at runtime, or a host method no tool
 * can reach. Removed APIs must be gone from the handlers but still stubbed in
 * the runtime, so old tools fail with a fix.
 */

import { describe, it, expect, vi } from "vitest"
import { TOOLS_BUILDER_SYSTEM_PROMPT } from "../../../../auth-worker/src/lib/tools/build-prompt"
import { REMOVED_APIS, isToolStale, rebuildRequest, removedApi } from "../../../../shared/tools/api-rev"
import { TOOL_SCOPES } from "../../../../shared/tools/manifest"
import { createBridgeHost } from "../host-bridge"
import { createToolHandlers } from "../host-handlers"
import { METHOD_SCOPES } from "../permissions"
import { TOOL_RUNTIME_SOURCE } from "../runtime-source"
import { defaultSmokeFixtures } from "../smoke"
import { buildToolSrcdoc } from "../srcdoc"
import { createFakeFramePair } from "./fake-frame"

const runtimeMethods = [...TOOL_RUNTIME_SOURCE.matchAll(/call\("([a-z]+\.[A-Za-z]+)"/g)].map((m) => m[1])
const removed = REMOVED_APIS.map((r) => r.method)
const live = runtimeMethods.filter((m) => !removed.includes(m))
const stub = defaultSmokeFixtures({ name: "x", description: "", scopes: [...TOOL_SCOPES], mounts: ["page"], apiRev: 1 })[1].data
const handlers = createToolHandlers(stub)

describe("bridge capability twins", () => {
  it("runtime and host handlers expose exactly the same live methods", () => {
    expect([...live].sort()).toEqual(Object.keys(handlers).sort())
  })

  it("every scoped method is a live method and every scope is reachable", () => {
    for (const m of Object.keys(METHOD_SCOPES)) expect(live).toContain(m)
    for (const s of TOOL_SCOPES) expect(Object.values(METHOD_SCOPES)).toContain(s)
  })

  it("the builder prompt documents every live method and no removed one", () => {
    for (const m of live) expect(TOOLS_BUILDER_SYSTEM_PROMPT, m).toContain(`aquilla.${m}`)
    for (const m of removed) expect(TOOLS_BUILDER_SYSTEM_PROMPT).not.toContain(`aquilla.${m}(`)
  })

  it("removed APIs are stubbed in the runtime but not handled", () => {
    for (const m of removed) {
      expect(runtimeMethods).toContain(m)
      expect(Object.keys(handlers)).not.toContain(m)
    }
  })

  it("a removed call fails with api_removed naming the replacement, and flags the host", async () => {
    const pair = createFakeFramePair()
    const onApiRemoved = vi.fn()
    const host = createBridgeHost({
      getFrameWindow: () => pair.frame as unknown as Window,
      handlers,
      authorize: async () => {},
      onApiRemoved,
    })
    const stop = host.listen(pair.host as unknown as Window)
    pair.run(buildToolSrcdoc("<script></script>", {
      tool: { id: "t", name: "T", version: 1 },
      project: { id: "p", name: "P" },
      user: { username: "u", roleLevel: 400 },
      mount: "page",
      theme: {},
    }))
    const aquilla = pair.frame.aquilla as { cells: { save: (e: unknown) => Promise<unknown> } }
    await expect(aquilla.cells.save({ fileId: "f", cellId: "c", value: "v" })).rejects.toMatchObject({ code: "api_removed" })
    expect(onApiRemoved).toHaveBeenCalledWith("cells.save", expect.stringContaining("cells.commit"))
    stop()
  })

  it("api_rev gate", () => {
    expect(isToolStale(1)).toBe(false)
    expect(isToolStale(0)).toBe(true)
    expect(isToolStale(99)).toBe(true)
    expect(removedApi("cells.save")?.replacement).toContain("cells.commit")
    expect(rebuildRequest(0)).toContain("cells.save was removed")
  })
})
