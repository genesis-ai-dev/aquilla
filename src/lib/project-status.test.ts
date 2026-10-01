import { describe, it, expect } from "vitest"
import { attentionRank, type PortfolioProject } from "@/lib/frontier/portfolio"
import { portfolioActivityStatus, portfolioAttentionReasons } from "@/lib/project-status"

const DAY = 24 * 60 * 60 * 1000

const base: PortfolioProject = {
  id: "p",
  name: "P",
  totalCells: 100,
  validatedCells: 0,
  filledCells: 0,
  aiDraftedCells: 0,
  lastEditAt: null,
  audioCells: 0,
  validatedAudioCells: 0,
  recordedMs: 0,
  deadlineAt: null,
  sourceLanguage: null,
  targetLanguage: null,
}

describe("portfolioActivityStatus", () => {
  const now = Date.now()

  it("never-translated project is not-started when lastEditAt is null", () => {
    expect(portfolioActivityStatus({ ...base, filledCells: 0, lastEditAt: null }, now)).toBe(
      "not-started",
    )
  })

  // AQU-639 regression guard: importing source text stamps files.last_edit_at,
  // so an imported-but-untranslated project carries a non-null (and eventually
  // stale) lastEditAt. It must still read as "not-started", not "Stalled" — the
  // presence of a source-import timestamp is not translation activity.
  it("imported-but-untranslated project is not-started even with a stale lastEditAt", () => {
    const staleImport = now - 30 * DAY
    expect(
      portfolioActivityStatus({ ...base, filledCells: 0, lastEditAt: staleImport }, now),
    ).toBe("not-started")
  })

  it("translated project gone quiet 14+ days is stalled", () => {
    expect(
      portfolioActivityStatus({ ...base, filledCells: 50, lastEditAt: now - 30 * DAY }, now),
    ).toBe("stalled")
  })

  it("translated work with no timestamp is stalled, not not-started", () => {
    expect(portfolioActivityStatus({ ...base, filledCells: 10, lastEditAt: null }, now)).toBe(
      "stalled",
    )
  })

  it("recently edited translated project is active", () => {
    expect(portfolioActivityStatus({ ...base, filledCells: 5, lastEditAt: now }, now)).toBe(
      "active",
    )
  })

  it("a translated project edited within the last 14 days is active, not stalled", () => {
    expect(
      portfolioActivityStatus({ ...base, filledCells: 5, lastEditAt: now - 3 * DAY }, now),
    ).toBe("active")
  })

  // AQU-950 regression guard. `lastEditAt` is MAX(cells.last_edit_at), and
  // cell.validate / cell.unvalidate never stamp that column (they write
  // cell_validators + cells.validated) — nor do audio takes, which live in
  // cell_audio. A team reviewing or recording daily therefore looked idle on
  // the scalar alone. The per-lane timestamp is file_section_progress.updated_at,
  // restamped by every counter-affecting event, so it sees that work.
  it("a project whose only recent work is review/audio is active, not stalled", () => {
    expect(
      portfolioActivityStatus(
        {
          ...base,
          filledCells: 50,
          lastEditAt: now - 40 * DAY,
          lanes: [{ lane: "", totalCells: 100, filledCells: 50, validatedCells: 20, lastEditAt: now - 2 * DAY }],
        },
        now,
      ),
    ).toBe("active")
  })

  it("takes the most recent lane, not the first — work in any lane counts", () => {
    expect(
      portfolioActivityStatus(
        {
          ...base,
          filledCells: 50,
          lastEditAt: now - 40 * DAY,
          lanes: [
            { lane: "", totalCells: 100, filledCells: 50, validatedCells: 0, lastEditAt: now - 40 * DAY },
            { lane: "gan", totalCells: 100, filledCells: 10, validatedCells: 0, lastEditAt: now - DAY },
          ],
        },
        now,
      ),
    ).toBe("active")
  })

  // The other half of the contract: widening the signal must not make every
  // project look busy. A project idle in the cells AND in every lane is still
  // Stalled, and that is what the partner wants the flag to mean.
  it("stays stalled when the cells and every lane have gone quiet", () => {
    expect(
      portfolioActivityStatus(
        {
          ...base,
          filledCells: 50,
          lastEditAt: now - 40 * DAY,
          lanes: [
            { lane: "", totalCells: 100, filledCells: 50, validatedCells: 0, lastEditAt: now - 30 * DAY },
            { lane: "gan", totalCells: 100, filledCells: 10, validatedCells: 0, lastEditAt: now - 60 * DAY },
          ],
        },
        now,
      ),
    ).toBe("stalled")
  })

  it("a lane with no activity yet never drags a recently edited project to stalled", () => {
    expect(
      portfolioActivityStatus(
        {
          ...base,
          filledCells: 50,
          lastEditAt: now - DAY,
          lanes: [{ lane: "gan", totalCells: 100, filledCells: 0, validatedCells: 0, lastEditAt: null }],
        },
        now,
      ),
    ).toBe("active")
  })

  it("an untranslated project stays not-started however fresh its lane rows are", () => {
    expect(
      portfolioActivityStatus(
        {
          ...base,
          filledCells: 0,
          lastEditAt: now - 30 * DAY,
          lanes: [{ lane: "", totalCells: 100, filledCells: 0, validatedCells: 0, lastEditAt: now }],
        },
        now,
      ),
    ).toBe("not-started")
  })
})

// AQU-950: the Status column and the attention sort must agree. Ranking a row
// as idle while its chip says otherwise is the failure mode AQU-1097 already
// called out for "Behind plan".
describe("attentionRank reads the same activity signal as the Stalled chip", () => {
  const now = Date.now()
  const quiet: PortfolioProject = { ...base, filledCells: 50, validatedCells: 0, lastEditAt: now - 40 * DAY }

  it("does not add the stale penalty to a project whose lanes show recent work", () => {
    const reviewed = {
      ...quiet,
      lanes: [{ lane: "", totalCells: 100, filledCells: 50, validatedCells: 20, lastEditAt: now - DAY }],
    }
    expect(attentionRank(reviewed, now)).toBeLessThan(attentionRank(quiet, now))
  })

  it("still penalises a project idle in the cells and in every lane", () => {
    const idle = {
      ...quiet,
      lanes: [{ lane: "", totalCells: 100, filledCells: 50, validatedCells: 0, lastEditAt: now - 40 * DAY }],
    }
    expect(attentionRank(idle, now)).toBe(attentionRank(quiet, now))
  })
})

describe("portfolioAttentionReasons: units late inside a healthy deadline (AQU-1097)", () => {
  const NOW = Date.parse("2026-09-02T12:00:00Z")
  const base = (over: Partial<PortfolioProject>): PortfolioProject => ({
    id: "p", name: "P", totalCells: 100, filledCells: 50, validatedCells: 0,
    aiDraftedCells: 0, audioCells: 0, validatedAudioCells: 0, recordedMs: 0,
    lastEditAt: NOW - 1000, deadlineAt: null, sourceLanguage: null, targetLanguage: null,
    ...over,
  } as PortfolioProject)

  it("raises 'Behind plan', NOT 'Overdue', when only units are late", () => {
    // The two must stay distinguishable: the rollup count, the attention
    // filter, the sort rank and the deadline tooltip all still mean the
    // project's own deadline, so reusing "Overdue" made one word mean two
    // things and left the reader unable to tell which.
    const r = portfolioAttentionReasons(base({ unitsOverdue: 2, deadlineAt: "2027-01-01" }), NOW)
    expect(r.map((x) => x.kind)).toContain("behind-plan")
    expect(r.map((x) => x.kind)).not.toContain("overdue")
    expect(r.find((x) => x.kind === "behind-plan")?.label).toBe("Behind plan")
  })

  it("says nothing extra when the project's own deadline has already blown", () => {
    const r = portfolioAttentionReasons(base({ unitsOverdue: 2, deadlineAt: "2020-01-01" }), NOW)
    expect(r.map((x) => x.kind)).toEqual(["overdue"])
  })

  it("stays quiet when no unit is late", () => {
    const r = portfolioAttentionReasons(base({ unitsOverdue: 0, deadlineAt: "2027-01-01" }), NOW)
    expect(r.map((x) => x.kind)).not.toContain("behind-plan")
  })

  it("treats a server that has never sent the field as no news", () => {
    // Old worker, new client: `unitsOverdue` is undefined, not zero.
    const r = portfolioAttentionReasons(base({ deadlineAt: "2027-01-01" }), NOW)
    expect(r.map((x) => x.kind)).not.toContain("behind-plan")
  })

  it("sorts between a blown deadline and idle work", () => {
    const late = attentionRank(base({ unitsOverdue: 1, deadlineAt: "2027-01-01" }), NOW)
    const blown = attentionRank(base({ deadlineAt: "2020-01-01" }), NOW)
    const stalledOnly = attentionRank(base({ lastEditAt: NOW - 40 * 24 * 3600_000 }), NOW)
    expect(blown).toBeGreaterThan(late)
    expect(late).toBeGreaterThan(stalledOnly)
  })
})
