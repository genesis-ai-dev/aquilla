// Cache and windowing tests for the passage-tag store (AQU-657, slice 1).
//
// The properties that matter here are the ones a translator would feel:
// reopening an unchanged file spends nothing, editing one passage re-tags only
// that passage, a failure is invisible, and tags survive a reload. The last one
// is why the memory mirror and IndexedDB have separate test seams — a test that
// clears both could not tell a working persistence layer from a broken one.
//
// It also covers the producer → consumer composition (AGENTS.md testing rule
// 12): a real route-shaped JSON body goes through `classifyPassageTagWindow` and
// into the store, so a response the route can produce is one the store can cache.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __clearPersistedPassageTags,
  __resetPassageTagCache,
  ensureTagsForPassages,
  tagsFor,
  toStoreNodes,
  type PassageTagStoreNode,
} from "./passage-tag-store"
import { classifyPassageTagWindow } from "./passage-tag-client"
import { MAX_NODES_PER_REQUEST } from "./passage-tag-request"
import { combinePassageTags, type PassageTagNode, type PassageTags } from "./passage-tags"

function node(key: string, text: string): PassageTagNode {
  return { key, label: key, text, startRef: null, endRef: null }
}

function storeNode(
  key: string,
  text: string,
  sourceEventIds: (string | null)[],
  participants: string[] = ["Jesus"],
): PassageTagStoreNode {
  return {
    node: node(key, text),
    candidates: { participants, related: [] },
    sourceEventIds,
  }
}

/** What the route returns for a window: model-decided tags for each node. */
function modelTags(window: readonly { node: PassageTagNode }[]): PassageTags[] {
  return window.map(({ node: value }) => ({
    nodeKey: value.key,
    participants: [{
      name: "Jesus",
      value: true,
      probability: 0.97,
      confidence: 0.94,
      decidedBy: "model" as const,
    }],
    sceneChange: {
      value: true,
      probability: 0.9,
      confidence: 0.8,
      decidedBy: "model" as const,
    },
    speech: { value: false, probability: 0.1, confidence: 0.8, decidedBy: "model" as const },
    refersTo: [],
  }))
}

beforeEach(async () => {
  await __clearPersistedPassageTags()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("tagsFor", () => {
  it("falls back to the heuristic for every uncached node, with no await", () => {
    const nodes = [
      storeNode("p1", "Jesus went up the mountain.", ["e1"]),
      storeNode("p2", "The crowd waited below.", ["e2"]),
    ]
    const tags = tagsFor(nodes)
    expect(tags).toHaveLength(2)
    expect(tags[0].participants[0]).toMatchObject({ name: "Jesus", value: true })
    expect(tags[0].participants[0].decidedBy).toBe("heuristic")
    expect(tags[1].participants[0]).toMatchObject({ value: false, decidedBy: "heuristic" })
  })

  it("matches combinePassageTags exactly on a cold cache", () => {
    const nodes = [storeNode("p1", "Jesus spoke.", ["e1"])]
    expect(tagsFor(nodes)).toEqual([
      combinePassageTags(nodes[0].node, null, nodes[0].candidates, null),
    ])
  })
})

describe("ensureTagsForPassages", () => {
  it("caches what the classifier returns and serves it synchronously after", async () => {
    const nodes = [storeNode("p1", "Someone spoke.", ["e1"])]
    const classify = vi.fn(async (window: readonly { node: PassageTagNode }[]) =>
      modelTags(window))

    await ensureTagsForPassages(nodes, classify)

    expect(classify).toHaveBeenCalledTimes(1)
    const tags = tagsFor(nodes)
    expect(tags[0].participants[0]).toMatchObject({ value: true, decidedBy: "model" })
    expect(tags[0].sceneChange).toMatchObject({ value: true, decidedBy: "model" })
  })

  it("spends nothing on a second pass over an unchanged file", async () => {
    const nodes = [storeNode("p1", "Someone spoke.", ["e1"])]
    const classify = vi.fn(async (window: readonly { node: PassageTagNode }[]) =>
      modelTags(window))

    await ensureTagsForPassages(nodes, classify)
    await ensureTagsForPassages(nodes, classify)

    expect(classify).toHaveBeenCalledTimes(1)
  })

  it("re-tags only the node whose source event changed", async () => {
    const before = [storeNode("p1", "A.", ["e1"]), storeNode("p2", "B.", ["e2"])]
    const classify = vi.fn(async (window: readonly { node: PassageTagNode }[]) =>
      modelTags(window))
    await ensureTagsForPassages(before, classify)
    expect(classify).toHaveBeenCalledTimes(1)

    // p2's cell was edited: a new source event id, so only its key misses.
    const after = [storeNode("p1", "A.", ["e1"]), storeNode("p2", "B edited.", ["e3"])]
    await ensureTagsForPassages(after, classify)

    expect(classify).toHaveBeenCalledTimes(2)
    // p1 still answers from the cache it had before the edit.
    expect(tagsFor([after[0]])[0].participants[0].decidedBy).toBe("model")
  })

  it("re-asks when the cast grows, because a short answer set is not a complete one", async () => {
    const classify = vi.fn(async (window: readonly { node: PassageTagNode }[]) =>
      modelTags(window))
    await ensureTagsForPassages([storeNode("p1", "A.", ["e1"], ["Jesus"])], classify)
    await ensureTagsForPassages(
      [storeNode("p1", "A.", ["e1"], ["Jesus", "Levi"])],
      classify,
    )
    expect(classify).toHaveBeenCalledTimes(2)
  })

  it("skips a window it could not cache, rather than paying on every pass", async () => {
    // A passage whose cells have no source event yet is unkeyable, so an answer
    // about it could not be stored — same rule as the seam store. Spending a call
    // per pass on an answer that is thrown away is worse than the heuristic.
    const nodes = [storeNode("p1", "A.", [null])]
    const classify = vi.fn(async (window: readonly { node: PassageTagNode }[]) =>
      modelTags(window))

    await ensureTagsForPassages(nodes, classify)
    await ensureTagsForPassages(nodes, classify)

    expect(classify).not.toHaveBeenCalled()
    expect(tagsFor(nodes)[0].participants[0].decidedBy).toBe("heuristic")
  })

  it("still tags the keyable nodes of a window that also holds an unkeyable one", async () => {
    const nodes = [storeNode("p1", "A.", [null]), storeNode("p2", "Jesus spoke.", ["e2"])]
    await ensureTagsForPassages(nodes, async (window) => modelTags(window))

    expect(tagsFor(nodes)[0].participants[0].decidedBy).toBe("heuristic")
    expect(tagsFor(nodes)[1].participants[0].decidedBy).toBe("model")
  })

  it("windows with one node of overlap so scene_change always has a predecessor", async () => {
    const nodes = Array.from(
      { length: MAX_NODES_PER_REQUEST + 3 },
      (_, i) => storeNode(`p${i}`, `Passage ${i}.`, [`e${i}`]),
    )
    const windows: string[][] = []
    await ensureTagsForPassages(nodes, async (window) => {
      windows.push(window.map((entry) => entry.node.key))
      return modelTags(window)
    })

    expect(windows).toHaveLength(2)
    expect(windows[0]).toHaveLength(MAX_NODES_PER_REQUEST)
    // The second window reopens on the first window's last node.
    expect(windows[1][0]).toBe(windows[0][windows[0].length - 1])
    // Every node after the first is covered with a predecessor in its window.
    expect(new Set(windows.flat()).size).toBe(nodes.length)
  })

  it("resolves quietly when the classifier throws, leaving reads heuristic", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const nodes = [storeNode("p1", "A.", ["e1"])]
    await expect(ensureTagsForPassages(nodes, async () => {
      throw new Error("upstream down")
    })).resolves.toBeUndefined()
    expect(tagsFor(nodes)[0].participants[0].decidedBy).toBe("heuristic")
  })

  it("ignores tags for a node that was not in the window", async () => {
    const nodes = [storeNode("p1", "A.", ["e1"])]
    await ensureTagsForPassages(nodes, async () => modelTags([{ node: node("ghost", "x") }]))
    expect(tagsFor(nodes)[0].participants[0].decidedBy).toBe("heuristic")
  })

  it("keeps tags across a reload — the memory mirror rehydrates from IndexedDB", async () => {
    const nodes = [storeNode("p1", "A.", ["e1"])]
    await ensureTagsForPassages(nodes, async (window) => modelTags(window))

    // A reload drops the mirror but not the store.
    __resetPassageTagCache()
    expect(tagsFor(nodes)[0].participants[0].decidedBy).toBe("heuristic")

    const classify = vi.fn(async (window: readonly { node: PassageTagNode }[]) =>
      modelTags(window))
    await ensureTagsForPassages(nodes, classify)
    expect(classify).not.toHaveBeenCalled()
    expect(tagsFor(nodes)[0].participants[0].decidedBy).toBe("model")
  })

  it("does nothing at all for an empty spine", async () => {
    const classify = vi.fn()
    await ensureTagsForPassages([], classify)
    expect(classify).not.toHaveBeenCalled()
  })
})

describe("route response → client → store", () => {
  it("caches tags that arrived as a real route-shaped JSON body", async () => {
    const nodes = [storeNode("p1", "Someone spoke.", ["e1"])]
    // Exactly what auth-worker's /api/v1/ai/passage-tags/classify returns.
    const body = JSON.stringify({
      tags: modelTags([{ node: nodes[0].node }]),
      model: "typesafe/jev-1.13",
    })
    const fetchImpl = vi.fn(async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }))

    await ensureTagsForPassages(nodes, (window) =>
      classifyPassageTagWindow(window, {
        identityToken: "token",
        projectId: "project",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(sent).toMatchObject({ projectId: "project" })
    expect(sent.nodes[0]).toMatchObject({ key: "p1", participants: ["Jesus"] })
    expect(tagsFor(nodes)[0].participants[0]).toMatchObject({ value: true, decidedBy: "model" })
  })

  it("leaves reads heuristic when the route answers with a body it cannot use", async () => {
    const nodes = [storeNode("p1", "Someone spoke.", ["e1"])]
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ tags: [{ nodeKey: "p1" }] }), { status: 200 }))

    await ensureTagsForPassages(nodes, (window) =>
      classifyPassageTagWindow(window, {
        identityToken: "token",
        projectId: "project",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }))

    expect(tagsFor(nodes)[0].participants[0].decidedBy).toBe("heuristic")
  })
})

describe("toStoreNodes", () => {
  it("pairs each spine node with its events and candidates", () => {
    const spine = [node("p1", "Jesus spoke."), node("p2", "Levi followed.")]
    const built = toStoreNodes(
      spine,
      (value) => [`event-for-${value.key}`],
      () => ({ participants: ["Jesus"], related: [] }),
    )
    expect(built).toHaveLength(2)
    expect(built[1]).toMatchObject({
      sourceEventIds: ["event-for-p2"],
      candidates: { participants: ["Jesus"] },
    })
  })
})
