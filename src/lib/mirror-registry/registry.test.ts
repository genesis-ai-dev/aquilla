import { describe, expect, test, vi } from "vitest"
import { LocalStore } from "@/lib/local-store"
import {
  MirrorRegistry,
  type Mirror,
  type MirrorContext,
} from "./registry"

async function makeCtx(): Promise<MirrorContext> {
  const store = await LocalStore.open({ name: ":memory:" })
  return {
    store,
    actorId: "u1",
    now: () => 1_000,
  }
}

function fakeMirror(
  name: string,
  hooks: Partial<Pick<Mirror, "bootstrap" | "attach">> = {},
): Mirror {
  return {
    name,
    async bootstrap(ctx) {
      await hooks.bootstrap?.(ctx)
    },
    attach(ctx) {
      return hooks.attach?.(ctx) ?? (() => {})
    },
  }
}

describe("MirrorRegistry", () => {
  test("register adds a mirror", () => {
    const registry = new MirrorRegistry()
    registry.register(fakeMirror("a"))
    registry.register(fakeMirror("b"))
    expect(registry.names()).toEqual(["a", "b"])
  })

  test("rejects duplicate registrations by name", () => {
    const registry = new MirrorRegistry()
    registry.register(fakeMirror("a"))
    expect(() => registry.register(fakeMirror("a"))).toThrow(/already/)
  })

  test("startAll runs every bootstrap then every attach, in order", async () => {
    const events: string[] = []
    const ctx = await makeCtx()
    const registry = new MirrorRegistry()
    registry.register(
      fakeMirror("first", {
        bootstrap: async () => {
          events.push("first.bootstrap")
        },
        attach: () => {
          events.push("first.attach")
          return () => events.push("first.dispose")
        },
      }),
    )
    registry.register(
      fakeMirror("second", {
        bootstrap: async () => {
          events.push("second.bootstrap")
        },
        attach: () => {
          events.push("second.attach")
          return () => events.push("second.dispose")
        },
      }),
    )

    const dispose = await registry.startAll(ctx)
    expect(events).toEqual([
      "first.bootstrap",
      "second.bootstrap",
      "first.attach",
      "second.attach",
    ])

    dispose()
    expect(events.slice(-2)).toEqual(["first.dispose", "second.dispose"])
    await ctx.store.close()
  })

  test("if a bootstrap throws, no mirrors get attached", async () => {
    const events: string[] = []
    const ctx = await makeCtx()
    const registry = new MirrorRegistry()
    registry.register(
      fakeMirror("ok", {
        bootstrap: async () => {
          events.push("ok.bootstrap")
        },
        attach: () => {
          events.push("ok.attach")
          return () => {}
        },
      }),
    )
    registry.register(
      fakeMirror("broken", {
        bootstrap: async () => {
          throw new Error("boom")
        },
        attach: () => {
          events.push("broken.attach")
          return () => {}
        },
      }),
    )
    await expect(registry.startAll(ctx)).rejects.toThrow(/boom/)
    expect(events).toEqual(["ok.bootstrap"])
    await ctx.store.close()
  })

  test("dispose can be called even after mid-lifecycle errors (idempotent)", async () => {
    const ctx = await makeCtx()
    const registry = new MirrorRegistry()
    const fn = vi.fn()
    registry.register(
      fakeMirror("ok", {
        attach: () => fn,
      }),
    )
    const dispose = await registry.startAll(ctx)
    dispose()
    dispose() // second call is a safe no-op
    expect(fn).toHaveBeenCalledTimes(1)
    await ctx.store.close()
  })
})
