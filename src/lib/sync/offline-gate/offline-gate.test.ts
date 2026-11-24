// Offline-sync gate.
//
// Why this exists (docs/RELEASE-RISK-GATES.md, forbidden outcome #4, and #1's
// "a commit that never reaches the log"): the IndexedDB outbox is the only
// copy of an offline edit until the server acks it. A flush that removes an
// event on a non-permanent error, or a reconnect that skips the queue, loses
// it silently. This suite drives the real outbox and its real drains through
// a table of scripted faults (scenarios.ts) against a fake server that keeps
// every event it accepted (harness.ts), and after each scenario asks one
// question the scenario's author does not get to answer: where is every event
// that was enqueued?
//
// The answer, per event, plus what the server saw, is compared to the
// committed golden (golden.json). A failure here is not a flake and not a
// fixture to update by reflex: it says the candidate build puts a queued edit
// somewhere else than production does. If that is the point of the change,
// regenerate (UPDATE_OFFLINE_GATE=1 pnpm vitest run src/lib/sync/offline-gate)
// and let the golden diff be reviewed. An event that ends up nowhere fails
// the gate whatever the golden says, unless the table names it as known.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act } from "@testing-library/react"
import type { OutboxRawEvent } from "../outbox-types"
import type { OutboxRecord } from "../outbox"
import {
  ACCOUNT,
  FakeLocks,
  GateServer,
  IdbOpenGate,
  WsFirstSender,
  httpCycle,
  installImmediateCounter,
  mountFlusher,
  openTab,
  readJournalIds,
  readOutboxRaw,
  run,
  settle,
  wipeOutbox,
  type Announcements,
  type Tab,
} from "./harness"
import { SCENARIOS, type EventSpec, type Scenario, type Step } from "./scenarios"

// `process` is the browser polyfill inside the app project; the env lives on
// the real one.
const UPDATE = globalThis.process?.env?.UPDATE_OFFLINE_GATE === "1"
const GOLDEN_PATH = join(__dirname, "golden.json")
const T0 = Date.UTC(2026, 0, 1)
/** Fake time moves in slices this long, the system settling after each. */
const SLICE_MS = 250

type Golden = Record<string, string>
const observed: Golden = {}

function readGolden(): Golden {
  if (!existsSync(GOLDEN_PATH)) {
    if (UPDATE) return {}
    throw new Error(`${GOLDEN_PATH} missing; run UPDATE_OFFLINE_GATE=1 to create it`)
  }
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden
}
const golden = readGolden()

// ── Events ────────────────────────────────────────────────────────────────

const CHAIN_KIND = /^(source|target)\.cell\.(create|commit|delete|reorder)$/

/** Build a scenario's events with stable ids (the label itself), each chained
 *  on the previous chain-mutating event declared for the same cell. */
function buildEvents(specs: Record<string, EventSpec>): Map<string, OutboxRawEvent> {
  const built = new Map<string, OutboxRawEvent>()
  const heads = new Map<string, string>()
  let n = 0
  for (const [label, spec] of Object.entries(specs)) {
    const kind = spec.kind ?? "target.cell.commit"
    const projectId = spec.project ?? "P1"
    const fileId = spec.file === null ? undefined : (spec.file ?? "F1")
    const cellId = spec.cell === null ? undefined : (spec.cell ?? "c1")
    const slot = `${projectId}|${fileId ?? ""}|${cellId ?? ""}`
    const chained = CHAIN_KIND.test(kind)
    const event = {
      id: label,
      schemaVersion: 1,
      kind,
      projectId,
      ...(fileId ? { fileId } : {}),
      ...(cellId ? { cellId } : {}),
      ...(chained ? { parentId: spec.parent ?? heads.get(slot) ?? `head-of-${cellId}` } : {}),
      author: "ana",
      payload: spec.payload ?? { value: `${label} text`, valueHtml: `<p>${label} text</p>` },
      clientTs: T0 + ++n,
    } as unknown as OutboxRawEvent
    if (chained) heads.set(slot, label)
    built.set(label, event)
  }
  return built
}

// ── Invariants ────────────────────────────────────────────────────────────

/** Paths at which two JSON values differ. */
function differences(a: unknown, b: unknown, path = ""): Array<{ path: string; from: unknown; to: unknown }> {
  if (a === b) return []
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].flatMap((key) =>
      differences((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key),
    )
  }
  return [{ path, from: a, to: b }]
}

/** The one content change the product documents (outbox-sanitize.ts,
 *  AQU-1368): a fractional `…Ms` number leaves rounded to an integer. */
function isDocumentedRepair(diff: { path: string; from: unknown; to: unknown }): boolean {
  return /Ms$/.test(diff.path) &&
    typeof diff.from === "number" && !Number.isInteger(diff.from) && diff.to === Math.round(diff.from)
}

interface Outcome {
  rows: Golden
  violations: string[]
}

/**
 * Where is every enqueued event? Computed from three independent reads — the
 * fake server's log, the raw IndexedDB store, the recovery journal — never
 * from what the product reports about itself.
 */
function classify(
  scenario: Scenario,
  events: ReadonlyMap<string, OutboxRawEvent>,
  enqueued: readonly string[],
  server: GateServer,
  outbox: readonly OutboxRecord[],
  journal: readonly string[],
  heard: Announcements,
): Outcome {
  const rows: Golden = {}
  const violations: string[] = []
  const key = (label: string) => `${scenario.drain}: ${scenario.name} · ${label}`
  const knownLoss = scenario.knownLoss ?? {}

  for (const label of enqueued) {
    const sent = events.get(label)!
    const accepted = server.log.find((entry) => entry.id === label)
    const record = outbox.find((r) => r.id === label)
    const journaled = journal.includes(label)
    const rejectedStatus = server.permanentlyRejected.get(label)
    const places = [
      accepted ? "the server's log" : null,
      record ? "the outbox" : journaled ? "the recovery journal" : null,
      !accepted && !record && !journaled && rejectedStatus !== undefined ? "removed after a permanent rejection" : null,
    ].filter((place): place is string => place !== null)

    let row: string
    if (places.length > 1) {
      violations.push(`${label} is in ${places.join(" AND ")}: the client still holds an event the server has`)
      row = `VIOLATION: ${places.join(" + ")}`
    } else if (accepted) {
      const diffs = differences(sent, accepted.event)
      const unexplained = diffs.filter((diff) => !isDocumentedRepair(diff))
      if (unexplained.length > 0) {
        violations.push(
          `${label} was accepted with different content: ` +
            unexplained.map((d) => `${d.path} ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`).join(", "),
        )
      }
      const repair = diffs.length > 0
        ? `; content: ${diffs.map((d) => `${d.path} ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`).join(", ")}`
        : ""
      row = accepted.stale
        ? `server (${accepted.via}): logged as a stale sibling, ${heard.stale.includes(label) ? "reported" : "NOT reported"}`
        : `server (${accepted.via})`
      row += repair
    } else if (record) {
      const changed = differences(sent, record.event)
      if (changed.length > 0) violations.push(`${label} is in the outbox with different content (${changed[0].path})`)
      if (record.ownerKey !== ACCOUNT) violations.push(`${label} is in the outbox under owner ${String(record.ownerKey)}`)
      const error = record.lastError ? `${record.lastError.status} "${record.lastError.reason}"` : "none"
      row = `${record.status === "failed" ? "held (failed, readable)" : "outbox (pending)"}: attempts=${record.attempts}, lastError=${error}`
    } else if (journaled) {
      row = "recovery journal (replayed on next load)"
    } else if (rejectedStatus !== undefined) {
      row = `removed: server rejected it ${rejectedStatus}, ${heard.rejected.includes(label) ? "reported" : "NOT reported"}`
    } else if (knownLoss[label]) {
      row = `LOST — ${knownLoss[label]}`
    } else {
      violations.push(`${label} is LOST: not in the server's log, the outbox or the journal, and never permanently rejected`)
      row = "LOST"
    }
    if (knownLoss[label] && !row.startsWith("LOST")) {
      violations.push(`${label} is listed as a known loss but is no longer lost (${row}); drop it from knownLoss`)
    }
    rows[key(label)] = row
  }

  // Per-cell order of what the server applied matches enqueue order.
  const lastIndexBySlot = new Map<string, { index: number; label: string }>()
  for (const entry of server.log) {
    const event = events.get(entry.id)
    if (!event) {
      violations.push(`the server accepted ${entry.id}, which no scenario step enqueued`)
      continue
    }
    const slot = `${event.projectId}|${event.fileId ?? ""}|${event.cellId ?? ""}`
    const index = enqueued.indexOf(entry.id)
    const before = lastIndexBySlot.get(slot)
    if (before && before.index > index) {
      violations.push(`cell ${slot}: the server took ${before.label} before ${entry.id}, the reverse of enqueue order`)
    }
    lastIndexBySlot.set(slot, { index, label: entry.id })
  }

  const deliveries = enqueued
    .filter((label) => server.deliveries.has(label))
    .map((label) => `${label}×${server.deliveries.get(label)}`)
  rows[key("(server)")] =
    `accepted=${server.log.length} [${server.log.map((e) => e.id).join(" ")}] ` +
    `posts=${server.eventPosts} deliveries=[${deliveries.join(" ")}] mints=${server.tokenMints}` +
    (heard.forbidden.length > 0 ? ` forbidden-reported=[${heard.forbidden.join(" ")}]` : "")
  return { rows, violations }
}

// ── The interpreter ───────────────────────────────────────────────────────

interface World {
  server: GateServer
  locks: FakeLocks
  gate: IdbOpenGate
  heard: Announcements
  tabs: Map<string, Tab>
  events: Map<string, OutboxRawEvent>
  enqueued: string[]
}

async function tabOf(world: World, name = "A"): Promise<Tab> {
  let tab = world.tabs.get(name)
  if (!tab) {
    tab = await openTab(name, world.heard)
    world.tabs.set(name, tab)
  }
  return tab
}

async function enqueueInOrder(tab: Tab, events: readonly OutboxRawEvent[]): Promise<void> {
  for (const event of events) {
    vi.setSystemTime(Date.now() + 1)
    await tab.outbox.enqueueOutboxEvent(event)
  }
}

async function perform(world: World, step: Step): Promise<void> {
  const { server } = world
  switch (step.do) {
    case "open":
      world.tabs.set(step.tab, await openTab(step.tab, world.heard))
      return
    case "enqueue": {
      const tab = await tabOf(world, step.tab)
      const events = step.events.map((label) => world.events.get(label)!)
      world.enqueued.push(...step.events)
      if (step.as === "batch") {
        vi.setSystemTime(Date.now() + 1)
        run(tab, `enqueue batch ${step.events.join(",")}`, tab.outbox.enqueueOutboxEvents(events))
      } else if (step.as === "unawaited") {
        for (const event of events) {
          vi.setSystemTime(Date.now() + 1)
          run(tab, `enqueue ${event.id}`, tab.outbox.enqueueOutboxEvent(event))
        }
      } else {
        run(tab, `enqueue ${step.events.join(",")}`, enqueueInOrder(tab, events))
      }
      return
    }
    case "net":
      server.online = step.online
      if (!step.online) server.dropSockets()
      window.dispatchEvent(new Event(step.online ? "online" : "offline"))
      return
    case "faults":
      if (step.events) server.eventsFaults.splice(0, Infinity, ...step.events.map((fault) => ({ ...fault })))
      if (step.token) server.tokenFaults.splice(0, Infinity, ...step.token.map((fault) => ({ ...fault })))
      return
    case "revokeTokens":
      server.revokeTokens()
      return
    case "expireSession":
      server.validJwts.clear()
      return
    case "reauth": {
      const tab = await tabOf(world, step.tab)
      server.validJwts.add(step.jwt)
      tab.jwt.current = step.jwt
      act(() => tab.hook?.rerender({ epoch: step.jwt }))
      return
    }
    case "release":
      server.release()
      return
    case "cycle": {
      const tab = await tabOf(world, step.tab)
      if (step.together) {
        for (let n = 0; n < step.together; n++) run(tab, "http cycle", httpCycle(tab))
        return
      }
      for (let n = 0; n < (step.times ?? 1); n++) {
        run(tab, "http cycle", httpCycle(tab))
        await settle(server, `http cycle ${n + 1}`)
      }
      return
    }
    case "releaseHolds":
      ;(await tabOf(world, step.tab)).flush.releaseElevationHolds()
      return
    case "mount":
      mountFlusher(await tabOf(world, step.tab))
      return
    case "unmount": {
      const tab = await tabOf(world, step.tab)
      tab.hook?.unmount()
      tab.hook = null
      return
    }
    case "advance":
      for (let moved = 0; moved < step.ms; moved += SLICE_MS) {
        await vi.advanceTimersByTimeAsync(Math.min(SLICE_MS, step.ms - moved))
        await settle(server, `advancing time (${moved + SLICE_MS} of ${step.ms} ms)`)
      }
      return
    case "clock":
      vi.setSystemTime(Date.now() + step.ms)
      return
    case "crash": {
      const tab = await tabOf(world, step.tab)
      tab.dead = true
      tab.neverOpened = world.gate.holding
      tab.hook?.unmount()
      tab.hook = null
      tab.sender?.close()
      world.gate.abandon()
      world.locks.freeAll()
      return
    }
    case "idb":
      if (step.opens === "hold") {
        // The page exists (its modules are loaded) before its storage stalls.
        await tabOf(world)
        world.gate.hold()
      } else if (step.opens === "pass") world.gate.pass()
      else world.gate.proceed()
      return
    case "ws": {
      const tab = await tabOf(world, step.tab)
      if (step.action === "connect") tab.sender = new WsFirstSender(tab, server.socketCtor())
      else if (step.action === "drop") server.dropSockets()
      else if (tab.sender) run(tab, "ws pump", tab.sender.pump())
      return
    }
    case "wsServer":
      if (step.up !== undefined) server.wsUp = step.up
      if (step.lossy) server.wsLossy = step.lossy
      return
  }
}

// ── The gate ──────────────────────────────────────────────────────────────

describe("offline-sync gate: every enqueued event is accounted for", () => {
  let world: World
  let restore: Array<() => void>

  beforeEach(() => {
    vi.useFakeTimers({
      // Not setImmediate: fake-indexeddb runs on it, and `settle` counts it.
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      now: T0,
    })
    // 0.5 is the identity draw for every jittered delay in the area: the
    // flusher sleeps exactly 5s × 2^failures, the `online` stagger is 1.25s,
    // the first reconnect window is 2.5s.
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    for (const level of ["error", "warn", "info", "log"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {})
    }
    const server = new GateServer()
    const locks = new FakeLocks()
    vi.stubGlobal("fetch", server.fetch)
    // The flusher's updates land outside act() by design: nothing here waits
    // on React, only on the outbox and the server.
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false)
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true })
    Object.defineProperty(navigator, "onLine", { get: () => server.online, configurable: true })
    restore = [
      installImmediateCounter(),
      () => Reflect.deleteProperty(navigator, "locks"),
      () => Reflect.deleteProperty(navigator, "onLine"),
    ]
    world = {
      server,
      locks,
      gate: new IdbOpenGate(),
      heard: { stale: [], rejected: [], forbidden: [] },
      tabs: new Map(),
      events: new Map(),
      enqueued: [],
    }
  })

  afterEach(async () => {
    world.gate.abandon()
    await wipeOutbox([...world.tabs.values()])
    for (const undo of restore) undo()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it.each(SCENARIOS.map((scenario) => [`${scenario.drain}: ${scenario.name}`, scenario] as const))(
    "%s",
    async (_title, scenario) => {
      world.events = buildEvents(scenario.events)
      for (const [n, step] of scenario.steps.entries()) {
        await perform(world, step)
        await settle(world.server, `step ${n + 1} (${step.do})`)
      }

      // A page that is still alive must have finished everything it started;
      // a dead one is exactly the case where nothing ever finishes.
      const live = [...world.tabs.values()].filter((tab) => !tab.dead)
      const unfinished = live.flatMap((tab) => tab.running.filter((w) => !w.done).map((w) => `${tab.name}: ${w.what}`))
      const failures = live.flatMap((tab) => tab.failures.map((failure) => `${tab.name}: ${failure}`))

      const { rows, violations } = classify(
        scenario,
        world.events,
        world.enqueued,
        world.server,
        await readOutboxRaw(),
        readJournalIds(),
        world.heard,
      )
      Object.assign(observed, rows)

      expect(unfinished, "work a live tab started never finished").toEqual([])
      expect(failures, "a live tab's outbox call threw").toEqual([])
      expect(violations, "an enqueued event is not where an offline edit may be").toEqual([])
      if (UPDATE) return
      const diffs: string[] = []
      for (const [key, value] of Object.entries(rows)) {
        if (!(key in golden)) diffs.push(`${key}\n      not in golden (observed: ${value})`)
        else if (golden[key] !== value) diffs.push(`${key}\n      golden:   ${golden[key]}\n      observed: ${value}`)
      }
      if (diffs.length > 0) {
        throw new Error(
          `${diffs.length} outcome(s) differ from offline-gate/golden.json\n  ${diffs.join("\n  ")}\n` +
            "If the change is intended, run UPDATE_OFFLINE_GATE=1 and have the golden diff reviewed.",
        )
      }
    },
  )

  it("has no golden row the table no longer produces", () => {
    if (UPDATE) return
    expect(Object.keys(golden).filter((key) => !(key in observed))).toEqual([])
  })
})

afterAll(() => {
  if (!UPDATE) return
  writeFileSync(GOLDEN_PATH, `${JSON.stringify(observed, null, 2)}\n`)
})
