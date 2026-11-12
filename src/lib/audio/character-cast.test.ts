import { describe, it, expect } from "vitest"
import {
  buildCharacterCastWrite,
  castLinesOf,
  castPickPatch,
  expandCharacterCast,
  foldCastByCharacter,
  setLaneCharacterCast,
  type CastLine,
  type CastScope,
} from "./character-cast"
import { LANE_CAST_DEFAULT, laneTtsSettings } from "./lane-cast"
import { laneScopedTtsSettings } from "./voice-lanes"
import {
  NO_CAST_VOICE,
  assignedCastVoiceId,
  characterCastKey,
  getVoiceLibrary,
  resolveCastVoice,
  resolveVoice,
} from "./voices"
import { buildCastAdditions } from "@/lib/import/cast-from-speakers"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

function voice(id: string, name = id, laneId?: string): Voice {
  return { id, name, color: "#475569", ...(laneId ? { laneId } : {}) }
}

describe("assignedCastVoiceId with characters (AQU-2125)", () => {
  const s: ProjectTtsSettings = {
    voices: [voice("v-jesus", "JESUS"), voice("v-peter", "PETER"), voice("v-other")],
    castAssignments: {
      [characterCastKey("JESUS")]: "v-jesus",
      c2: "v-other",
      c3: NO_CAST_VOICE,
      [characterCastKey("PETER")]: NO_CAST_VOICE,
    },
  }

  it("finds a line's character when the line has no entry of its own", () => {
    expect(assignedCastVoiceId(s, { id: "c1", metadata: { cast_name: "JESUS" } })).toBe("v-jesus")
    expect(assignedCastVoiceId(s, { id: "c1", castName: " JESUS " })).toBe("v-jesus")
  })

  it("lets the line's own entry win over its character", () => {
    expect(assignedCastVoiceId(s, { id: "c2", metadata: { cast_name: "JESUS" } })).toBe("v-other")
  })

  it("stops at a 'no voice' entry, for a line or for a character", () => {
    expect(assignedCastVoiceId(s, { id: "c3", metadata: { cast_name: "JESUS" } })).toBeUndefined()
    expect(resolveCastVoice(s, { id: "c3", metadata: { cast_name: "JESUS" } }, "v-peter").id).toBe("v-peter")
    expect(assignedCastVoiceId(s, { id: "c4", castName: "PETER" })).toBeUndefined()
  })

  it("finds nothing from a bare id, a line with no character, or a key a cell id cannot reach", () => {
    expect(assignedCastVoiceId(s, "c1")).toBeUndefined()
    expect(assignedCastVoiceId(s, { id: "c1" })).toBeUndefined()
    expect(assignedCastVoiceId(s, { id: "c1", metadata: { cast_name: "" } })).toBeUndefined()
    expect(assignedCastVoiceId(s, { id: "constructor", castName: "toString" })).toBeUndefined()
  })

  it("keeps a character's entry through the lane projection, with a lane's own answer on top", () => {
    const lanes: ProjectTtsSettings = {
      ...s,
      laneCastAssignments: { es: { [characterCastKey("JESUS")]: "v-peter", c5: LANE_CAST_DEFAULT } },
    }
    const es = laneTtsSettings(lanes, "es")
    expect(assignedCastVoiceId(es, { id: "c1", castName: "JESUS" })).toBe("v-peter")
    // Sent back to the lane default: the character must not take it back.
    expect(assignedCastVoiceId(es, { id: "c5", castName: "JESUS" })).toBeUndefined()
    expect(assignedCastVoiceId(laneTtsSettings(lanes, "fr"), { id: "c1", castName: "JESUS" })).toBe("v-jesus")
  })
})

describe("castLinesOf / expandCharacterCast", () => {
  it("lists only lines that name someone, once each", () => {
    expect(castLinesOf([
      { id: "a", metadata: { cast_name: "JESUS" } },
      { id: "b", metadata: {} },
      { id: "a", metadata: { cast_name: "JESUS" } },
      { id: "c", castName: "PETER" },
    ])).toEqual([{ id: "a", castName: "JESUS" }, { id: "c", castName: "PETER" }])
  })

  it("writes the character's voice onto lines with no entry, and is the same object when there is nothing to copy", () => {
    const s: ProjectTtsSettings = {
      voices: [voice("v-j")],
      castAssignments: { [characterCastKey("JESUS")]: "v-j", b: "v-x" },
    }
    const view = expandCharacterCast(s, [{ id: "a", castName: "JESUS" }, { id: "b", castName: "JESUS" }])
    expect(view?.castAssignments).toEqual({ [characterCastKey("JESUS")]: "v-j", b: "v-x", a: "v-j" })
    expect(assignedCastVoiceId(view, "a")).toBe("v-j")
    expect(s.castAssignments).not.toHaveProperty("a")
    expect(expandCharacterCast(s, [{ id: "c", castName: "NOBODY" }])).toBe(s)
    const plain: ProjectTtsSettings = { castAssignments: { a: "v-j" } }
    expect(expandCharacterCast(plain, [{ id: "a", castName: "JESUS" }])).toBe(plain)
  })
})

describe("foldCastByCharacter", () => {
  const lines: CastLine[] = [
    { id: "j1", castName: "JESUS" },
    { id: "j2", castName: "JESUS" },
    { id: "j3", castName: "JESUS" },
    { id: "j4", castName: "JESUS" },
    { id: "p1", castName: "PETER" },
  ]

  it("keeps the majority voice on the character and only the exceptions on lines", () => {
    const fold = foldCastByCharacter(
      { j1: "v-j", j2: "v-j", j3: "v-narr", j4: "v-j", p1: "v-p", other: "v-x" },
      lines,
    )
    expect(fold.castAssignments).toEqual({
      [characterCastKey("JESUS")]: "v-j",
      [characterCastKey("PETER")]: "v-p",
      j3: "v-narr",
      other: "v-x",
    })
    expect(fold).toMatchObject({ droppedLineEntries: 4, characterEntries: 2, newlyVoicedLines: 0, changed: true })
  })

  it("respects a character entry that already exists", () => {
    const fold = foldCastByCharacter(
      { [characterCastKey("JESUS")]: "v-clone", j1: "v-j", j2: "v-clone" },
      lines.slice(0, 2),
    )
    expect(fold.castAssignments).toEqual({ [characterCastKey("JESUS")]: "v-clone", j1: "v-j" })
    expect(fold.characterEntries).toBe(0)
  })

  it("counts, or marks, the lines that named a character but had no voice", () => {
    const map = { j1: "v-j", j2: "v-j" }
    const loose = foldCastByCharacter(map, lines.slice(0, 4))
    expect(loose.newlyVoicedLines).toBe(2)
    expect(loose.castAssignments).toEqual({ [characterCastKey("JESUS")]: "v-j" })
    const strict = foldCastByCharacter(map, lines.slice(0, 4), { keepUncastLines: true })
    expect(strict.markedLines).toBe(2)
    expect(strict.castAssignments).toEqual({ [characterCastKey("JESUS")]: "v-j", j3: NO_CAST_VOICE, j4: NO_CAST_VOICE })
  })

  it("changes nothing for a character none of whose lines is cast, and reports no change twice", () => {
    const once = foldCastByCharacter({ j1: "v-j" }, lines)
    expect(foldCastByCharacter({}, lines).changed).toBe(false)
    expect(foldCastByCharacter(once.castAssignments, lines).changed).toBe(false)
  })
})

describe("buildCharacterCastWrite", () => {
  it("casts each character once, reusing voices by name, and drops the imported lines' own entries", () => {
    let n = 0
    const before: ProjectTtsSettings = {
      voices: [voice("preset-narrator", "Narrator"), voice("v-j", "JESUS")],
      castAssignments: { a: "v-j", keep: "v-j" },
    }
    const out = buildCharacterCastWrite(
      [{ cellId: "a", castName: "JESUS" }, { cellId: "b", castName: "MARY" }, { cellId: "c", castName: "MARY" }, { cellId: "d", castName: "" }],
      before,
      () => `new-${++n}`,
    )
    expect(out.voices.map((v) => v.name)).toEqual(["Narrator", "JESUS", "MARY"])
    expect(out.castAssignments).toEqual({
      keep: "v-j",
      [characterCastKey("JESUS")]: "v-j",
      [characterCastKey("MARY")]: "new-1",
    })
  })

  it("never undoes a recast character, but repairs one pointing at a deleted voice", () => {
    const recast = buildCharacterCastWrite(
      [{ cellId: "a", castName: "JESUS" }],
      { voices: [voice("v-j", "JESUS"), voice("v-clone")], castAssignments: { [characterCastKey("JESUS")]: "v-clone" } },
      () => "unused",
    )
    expect(recast.castAssignments[characterCastKey("JESUS")]).toBe("v-clone")
    const repaired = buildCharacterCastWrite(
      [{ cellId: "a", castName: "JESUS" }],
      { voices: [voice("v-j", "JESUS")], castAssignments: { [characterCastKey("JESUS")]: "v-gone" } },
      () => "unused",
    )
    expect(repaired.castAssignments[characterCastKey("JESUS")]).toBe("v-j")
  })
})

describe("setLaneCharacterCast", () => {
  const base: ProjectTtsSettings = {
    voices: [voice("v-j", "JESUS"), voice("v-new")],
    castAssignments: { j1: "v-j", [characterCastKey("JESUS")]: "v-j" },
    laneCastAssignments: { "": { j2: "v-j" } },
  }

  it("casts the character on the lane, and gives a line still held elsewhere its own lane entry", () => {
    const patch = setLaneCharacterCast(base, "", null, "JESUS", "v-new", ["j1", "j2", "j3"])
    expect(patch.laneCastAssignments).toEqual({ "": { [characterCastKey("JESUS")]: "v-new", j1: "v-new" } })
    const view = laneTtsSettings({ ...base, ...patch }, "")
    for (const id of ["j1", "j2", "j3"]) expect(assignedCastVoiceId(view, { id, castName: "JESUS" })).toBe("v-new")
  })

  it("sends the whole character back to the lane default", () => {
    const patch = setLaneCharacterCast(base, "", null, "JESUS", null, ["j1", "j3"])
    const view = laneTtsSettings({ ...base, ...patch }, "")
    expect(assignedCastVoiceId(view, { id: "j1", castName: "JESUS" })).toBeUndefined()
    expect(assignedCastVoiceId(view, { id: "j3", castName: "JESUS" })).toBeUndefined()
  })
})

// ── The proof the ticket asks for: same voice for every line ───────────────
//
// A dubbing project cast the old way, at the size that broke Come and See:
// twelve episodes, each a subtitle file and a heard-line file, every line
// carrying its character, every one of them cast line by line by the character
// sheets — plus the things real projects pick up: a handful of lines recast by
// hand, a line with a pinned voice, lines whose casting save was refused, and a
// second language with its own choices.

const CHARACTERS = ["JESUS", "MATTHEW", "SIMON", "ANDREW", "JOHN", "BIG JAMES", "PHILIP", "MARY MAGDALENE", "THOMAS", "RAMAH", "ZEE", "NICODEMUS"]
const EPISODES = 12
const LINES_PER_FILE = 650

interface FixtureCell { id: string; metadata: { cast_name?: string }; ttsSettings?: { voiceId?: string } }

function uuidish(i: number): string {
  const hex = i.toString(16).padStart(12, "0")
  return `0199f1c2-7a3b-7c4d-8e5f-${hex}`
}

function buildFixture(): { settings: ProjectTtsSettings; cells: FixtureCell[]; overrides: string[]; refused: string[]; pinned: string } {
  const cells: FixtureCell[] = []
  let n = 0
  for (let ep = 0; ep < EPISODES; ep++) {
    for (const kind of ["subtitle", "heard"]) {
      for (let i = 0; i < LINES_PER_FILE; i++) {
        // A realistic spread: Jesus speaks most, the rest in turn.
        const who = i % 3 === 0 ? "JESUS" : CHARACTERS[(i * 7 + ep + (kind === "heard" ? 1 : 0)) % CHARACTERS.length]
        cells.push({ id: uuidish(++n), metadata: { cast_name: who } })
      }
    }
  }
  // Old-style casting, exactly as the character sheet imported it.
  const additions = buildCastAdditions(
    cells.map((c) => ({ cellId: c.id, speaker: c.metadata.cast_name })),
    undefined,
    (() => { let v = 0; return () => `0199f1c2-0000-7000-8000-${(++v).toString(16).padStart(12, "0")}` })(),
  )
  const library = additions.voices
  const narrator = library[0].id
  const castAssignments = { ...additions.castAssignments }
  // Lines recast by hand, to a voice that is not their character's.
  const overrides = [cells[5].id, cells[900].id, cells[4000].id, cells[9001].id]
  for (const id of overrides) castAssignments[id] = narrator
  // A line whose character sheet save never landed.
  const refused = [cells[777].id, cells[778].id]
  for (const id of refused) delete castAssignments[id]
  // A line with its own pinned voice and no cast entry.
  const pinned = cells[1234].id
  delete castAssignments[pinned]
  cells[1234].ttsSettings = { voiceId: library[3].id }
  // A second language that recast one character and sent one line to its default.
  const es = library.find((v) => v.name === "MATTHEW")!.id
  const settings: ProjectTtsSettings = {
    voices: library,
    defaultVoiceId: narrator,
    castAssignments,
    laneCastAssignments: { es: { [cells[10].id]: es, [cells[11].id]: LANE_CAST_DEFAULT } },
  }
  return { settings, cells, overrides, refused, pinned }
}

/** The voice every line spoke with BEFORE AQU-2125, rebuilt from the old rules
 *  (the lane projection deleted a lane-default entry; a line had only its own
 *  entry, then its pin, then the default). Built once per lane. */
function oldVoices(settings: ProjectTtsSettings, lane: string): (cell: FixtureCell) => string {
  const map: Record<string, string> = { ...(settings.castAssignments ?? {}) }
  for (const [id, v] of Object.entries(settings.laneCastAssignments?.[lane] ?? {})) {
    if (v === LANE_CAST_DEFAULT) delete map[id]
    else map[id] = v
  }
  return (cell) => resolveVoice(settings, map[cell.id] ?? cell.ttsSettings?.voiceId).id
}

function newVoices(settings: ProjectTtsSettings, lane: string): (cell: FixtureCell) => string {
  const view = laneTtsSettings(laneScopedTtsSettings(settings, null), lane)
  return (cell) => resolveCastVoice(view, cell, cell.ttsSettings?.voiceId).id
}

/** Every cell whose voice differs between the two readings. */
function differing(cells: readonly FixtureCell[], a: (c: FixtureCell) => string, b: (c: FixtureCell) => string): string[] {
  return cells.filter((c) => a(c) !== b(c)).map((c) => c.id)
}

describe("folding a real-sized dubbing project keeps every line's voice (AQU-2125)", () => {
  const { settings, cells, overrides, refused, pinned } = buildFixture()
  const lines = castLinesOf(cells)
  const bytes = (s: ProjectTtsSettings) => new TextEncoder().encode(JSON.stringify(s)).length

  it("starts over the 1 MB cap, as the Come and See project did", () => {
    expect(bytes(settings)).toBeGreaterThan(1_048_576)
  })

  it("gives every line, in both languages, exactly the voice it had", () => {
    const fold = foldCastByCharacter(settings.castAssignments, lines, { keepUncastLines: true })
    const folded = { ...settings, castAssignments: fold.castAssignments }
    expect(cells.length).toBe(EPISODES * 2 * LINES_PER_FILE)
    for (const lane of ["", "es"]) {
      expect(differing(cells, newVoices(folded, lane), oldVoices(settings, lane))).toEqual([])
    }
    // Twelve characters, the four hand-recast lines, and the two refused lines
    // and the pinned one held as they were: tens of entries where there were 15,600.
    expect(Object.keys(fold.castAssignments).length).toBe(CHARACTERS.length + overrides.length + refused.length + 1)
    expect(bytes(folded)).toBeLessThan(20_000)
  })

  it("by default gives the lines whose casting never saved their character's voice, and only those", () => {
    const fold = foldCastByCharacter(settings.castAssignments, lines)
    const folded = { ...settings, castAssignments: fold.castAssignments }
    expect(fold.newlyVoicedLines).toBe(refused.length)
    // The pinned line keeps its pin even here.
    expect(fold.castAssignments[pinned]).toBe(NO_CAST_VOICE)
    const after = newVoices(folded, "")
    expect(differing(cells, after, oldVoices(settings, "")).sort()).toEqual([...refused].sort())
    for (const id of refused) {
      const cell = cells.find((c) => c.id === id)!
      const named = getVoiceLibrary(settings).find((v) => v.name === cell.metadata.cast_name)!
      expect(after(cell)).toBe(named.id)
    }
  })

  it("reads the same through the in-memory view a surface that only knows ids gets", () => {
    const fold = foldCastByCharacter(settings.castAssignments, lines, { keepUncastLines: true })
    const view = expandCharacterCast(laneTtsSettings({ ...settings, castAssignments: fold.castAssignments }, ""), lines)
    const byIdOnly = (cell: FixtureCell) => resolveCastVoice(view, cell.id, cell.ttsSettings?.voiceId).id
    expect(differing(cells, byIdOnly, oldVoices(settings, ""))).toEqual([])
  })
})

describe("castPickPatch: how far a pick reaches (Sam, Oct 23)", () => {
  const narr: Voice = { id: "narr", name: "Narrator", color: "#475569", builtIn: true }
  const jesusV: Voice = { id: "v-jesus", name: "JESUS", color: "#0e7490" }
  const alt: Voice = { id: "v-alt", name: "Jesus (Pedro)", color: "#7c3aed" }
  // Episode A is open; episode B is another file of the same project.
  const A = ["a1", "a2"]
  const B = ["b1", "b2"]
  const lines = [...A, ...B].map((id) => ({ id, castName: "JESUS" }))
  const view = (s: ProjectTtsSettings) => laneTtsSettings(laneScopedTtsSettings(s, null), "")
  const voiceOf = (s: ProjectTtsSettings, id: string) => assignedCastVoiceId(view(s), { id, castName: "JESUS" })
  const apply = (s: ProjectTtsSettings, scope: CastScope, voiceId = alt.id): ProjectTtsSettings => ({
    ...s,
    ...castPickPatch(s, "", null, { scope, lineId: "a1", castName: "JESUS", fileLineIds: A, voiceId }),
  })
  // What a maintainer's save does next: fold the project-wide map over every line.
  const fold = (s: ProjectTtsSettings): ProjectTtsSettings => ({
    ...s,
    castAssignments: foldCastByCharacter(s.castAssignments, lines).castAssignments,
  })
  const castByCharacter: ProjectTtsSettings = { voices: [narr, jesusV, alt], castAssignments: { [characterCastKey("JESUS")]: jesusV.id } }
  const castLineByLine: ProjectTtsSettings = { voices: [narr, jesusV, alt], castAssignments: Object.fromEntries([...A, ...B].map((id) => [id, jesusV.id])) }
  const neverCast: ProjectTtsSettings = { voices: [narr, jesusV, alt], castAssignments: {} }

  it("this line: only the line the picker was opened on", () => {
    const s = apply(castByCharacter, "line")
    expect([...A, ...B].map((id) => voiceOf(s, id))).toEqual([alt.id, jesusV.id, jesusV.id, jesusV.id])
  })

  it.each([
    ["cast by character", castByCharacter, jesusV.id],
    ["cast line by line", castLineByLine, jesusV.id],
    ["never cast", neverCast, undefined],
  ] as const)("this file: every line of the character in the open file, other episodes untouched, through a fold too (%s)", (_label, start, otherEpisode) => {
    const s = apply(start, "file")
    expect([...A, ...B].map((id) => voiceOf(s, id))).toEqual([alt.id, alt.id, otherEpisode, otherEpisode])
    const folded = fold(s)
    expect([...A, ...B].map((id) => voiceOf(folded, id))).toEqual([alt.id, alt.id, otherEpisode, otherEpisode])
  })

  it("every episode: the character itself, so another episode's lines follow", () => {
    const s = apply(castByCharacter, "everywhere")
    expect([...A, ...B].map((id) => voiceOf(s, id))).toEqual([alt.id, alt.id, alt.id, alt.id])
    expect(s.laneCastAssignments?.[""]).toEqual({ [characterCastKey("JESUS")]: alt.id })
  })

  it("a this-file pick in another episode survives a later every-episode pick", () => {
    const inB = { ...castByCharacter, ...castPickPatch(castByCharacter, "", null, { scope: "file", lineId: "b1", castName: "JESUS", fileLineIds: B, voiceId: narr.id }) }
    const s = apply(inB, "everywhere")
    expect([...A, ...B].map((id) => voiceOf(s, id))).toEqual([alt.id, alt.id, narr.id, narr.id])
  })

  it("a line without a character is only ever this line, whatever the scope", () => {
    for (const scope of ["file", "everywhere"] as const) {
      const patch = castPickPatch(castByCharacter, "", null, { scope, lineId: "x1", castName: null, fileLineIds: ["x1", "x2"], voiceId: alt.id })
      expect(patch.laneCastAssignments?.[""]).toEqual({ x1: alt.id })
    }
  })
})
