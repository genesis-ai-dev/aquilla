// AQU-490: carrying Codex's per-take validations across.
//
// Codex has had audio validation since 2024 and the field teams have used it
// heavily — 2,577 validations by named users across the notebooks measured for
// the research board. Without this mapping a migrated project arrives saying
// nobody ever listened to anything, and the Pattani Malay and Chosen teams
// would be asked to redo work they finished years ago.
import { describe, it, expect } from "vitest"
import { audioValidateEvents, type AudioImport } from "./audio"
import { buildCellAudioEvents } from "./audio-copy"

const opts = { projectId: "p1", fileId: "f1", fallbackAuthor: "migrator", fallbackTs: 1000 }

const take = (over: Partial<AudioImport> = {}): AudioImport => ({
  legacyAudioId: "legacy-1",
  aquillaAudioId: "audio-1.webm",
  diskRelPath: "files/audio-1.webm",
  slot: "recording",
  ...over,
})

describe("audioValidateEvents", () => {
  it("emits one validate per live validator, keeping name and timestamp", () => {
    const events = audioValidateEvents("c1", take({
      validatedBy: [
        { username: "ana", creationTimestamp: 111 },
        { username: "bo", creationTimestamp: 222 },
      ],
    }), opts)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      kind: "cell.audio.validate", fileId: "f1", cellId: "c1",
      author: "ana", clientTs: 111, payload: { audioId: "audio-1.webm" },
    })
    expect(events[1]).toMatchObject({ author: "bo", clientTs: 222 })
  })

  // Codex un-validates by tombstoning rather than removing, so importing a
  // deleted entry would resurrect a validation its owner explicitly withdrew.
  it("drops tombstoned validations", () => {
    const events = audioValidateEvents("c1", take({
      validatedBy: [
        { username: "ana", creationTimestamp: 111 },
        { username: "bo", creationTimestamp: 222, isDeleted: true },
      ],
    }), opts)
    expect(events.map((e) => e.author)).toEqual(["ana"])
  })

  // The sync-worker rejects an event with an empty author and takes the whole
  // ingest chunk down with it, so a nameless validator borrows the migration's
  // author rather than sinking the import.
  it("falls back to the migration author when the username was lost", () => {
    const events = audioValidateEvents("c1", take({
      validatedBy: [{ creationTimestamp: 111 }],
    }), opts)
    expect(events).toHaveLength(1)
    expect(events[0].author).toBe("migrator")
  })

  // …but each nameless one still needs its OWN id, or they collide into a
  // single event and all but one of the validations silently vanishes.
  it("keys nameless validators on their own timestamp, so they do not collide", () => {
    const events = audioValidateEvents("c1", take({
      validatedBy: [{ creationTimestamp: 111 }, { creationTimestamp: 222 }],
    }), opts)
    expect(events).toHaveLength(2)
    expect(events[0].id).not.toBe(events[1].id)
  })

  it("skips an entry with neither a name nor a timestamp to key on", () => {
    expect(audioValidateEvents("c1", take({ validatedBy: [{}] }), opts)).toEqual([])
  })

  it("emits nothing for a take nobody validated", () => {
    expect(audioValidateEvents("c1", take(), opts)).toEqual([])
    expect(audioValidateEvents("c1", take({ validatedBy: [] }), opts)).toEqual([])
  })

  // A re-sync must converge: the id is keyed on the validator, never on the
  // take's attach event, whose id moves as the chain advances.
  it("produces a stable id across runs", () => {
    const once = audioValidateEvents("c1", take({ validatedBy: [{ username: "ana", creationTimestamp: 1 }] }), opts)
    const twice = audioValidateEvents("c1", take({ validatedBy: [{ username: "ana", creationTimestamp: 1 }] }), opts)
    expect(once[0].id).toBe(twice[0].id)
  })
})

describe("buildCellAudioEvents", () => {
  // Order is the rule: a validate that preceded its own attach would vote on a
  // row that does not exist yet.
  it("puts each take's validations immediately behind its attach", () => {
    const events = buildCellAudioEvents(
      "c1",
      [
        take({ aquillaAudioId: "a.webm", validatedBy: [{ username: "ana", creationTimestamp: 1 }] }),
        take({ aquillaAudioId: "b.webm", validatedBy: [{ username: "bo", creationTimestamp: 2 }] }),
      ],
      "b.webm",
      opts,
    )
    expect(events.map((e) => e.kind)).toEqual([
      "cell.audio.attach", "cell.audio.validate",
      "cell.audio.attach", "cell.audio.validate",
      "cell.audio.select",
    ])
    expect(events[1].payload).toMatchObject({ audioId: "a.webm" })
    expect(events[3].payload).toMatchObject({ audioId: "b.webm" })
  })

  it("leaves an unvalidated import exactly as it was", () => {
    const events = buildCellAudioEvents("c1", [take({ aquillaAudioId: "a.webm" })], "a.webm", opts)
    expect(events.map((e) => e.kind)).toEqual(["cell.audio.attach", "cell.audio.select"])
  })
})
