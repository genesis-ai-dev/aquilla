// AQU-2731 — search in the scripts a word index cannot search.
//
// The default search is Postgres full-text over `cells.value_tsv`, and a
// tsvector holds WORDS: text is cut at spaces and punctuation.
//
//   - Chinese, Japanese, Thai, Burmese, Lao, Khmer and Tibetan put no space
//     between words, so a whole clause is one "word" and a two-character term
//     inside it is not in the index. A partner searching 2 Kings for 器皿
//     ("vessels") got no results with the word on screen in front of them.
//   - Korean has spaces, but a word is written joined to its particles:
//     하나님 ("God") is in the text as 하나님이, 하나님의, 하나님께서. The index
//     holds those, so the stem finds almost nothing.
//
// Pinned here:
//   1. a query in one of those scripts is matched as text, not as words;
//   2. its hits come back by relevance, in a fixed order;
//   3. every other script still goes to the word index, behaving as before;
//   4. "search this file" is a server filter. It used to be applied in the
//      browser AFTER the server had cut the project-wide list to `limit`, so
//      a book's hits were dropped whenever the rest of the project had enough
//      hits to fill the page.
import { describe, it, expect, vi } from "vitest"
import { fetchProjectSearch } from "../../../src/lib/sync/search-read"
import { handleSearchReadRequest } from "../events/search-route"
import { makeVerifiedProjectId, queryScopedExact, queryScopedSearch } from "../events/scoped-search"
import type { SyncTokenClaims } from "../auth"
import { type CellRow } from "./helpers/in-memory-db"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

// The browser's fetcher only needs an origin; the real one reads Vite's env.
vi.mock("../../../src/lib/sync/sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://w",
}))

const SECRET = "search-secret"
const PROJECT = "proj-zh"
const claims = { userId: 1, projectId: PROJECT, fileId: "", role: 200, aud: "sync", iat: 0, exp: 0 } as SyncTokenClaims
const project = makeVerifiedProjectId(claims)

/** A seed row. These are columns the shared fixture type does not name. */
type SeedCell = CellRow & {
  lane_id?: string | null
  sequence_index?: number | null
  hidden_at?: number | null
}

function cell(
  fileId: string,
  cellId: string,
  side: "source" | "target",
  value: string,
  over: Partial<SeedCell> = {},
): SeedCell {
  return {
    project_id: PROJECT,
    file_id: fileId,
    cell_id: cellId,
    side,
    value,
    anchor_cell_id: null,
    event_id: `e-${fileId}-${cellId}-${side}`,
    last_editor: null,
    last_edit_at: 0,
    validated: 0,
    word_count: 1,
    ...over,
  }
}

// 2 Kings 12:13 and 25:14 (CUV) both name 器皿; 2 Kings 1:1 does not.
const KINGS_12_13 = "但那奉到耶和華殿的銀子，沒有用以做銀杯、蠟剪、碗、號，和別樣的金銀器皿，"
const KINGS_25_14 = "又帶去鍋、鏟子、蠟剪、調羹，並所用的一切銅器皿，"
const KINGS_1_1 = "亞哈死後，摩押背叛以色列。"

// Genesis in Korean. 하나님 never stands alone in any of these.
const GEN_1_1 = "태초에 하나님이 천지를 창조하시니라"
const GEN_1_2 = "땅이 혼돈하고 공허하며 흑암이 깊음 위에 있고 하나님의 신은 수면에 운행하시니라"
const GEN_1_5 = "저녁이 되며 아침이 되니 이는 첫째 날이니라"
const GEN_1_27 = "하나님이 자기 형상 곧 하나님의 형상대로 사람을 창조하시되 남자와 여자를 창조하시고"
const GEN_2_4 = "여호와 하나님께서 땅과 하늘을 만드시던 날에"

interface Hit {
  cellId: string
  fileId: string
  side: string
  value: string
  snippet: string
  rank: number
  pairedValue: string | null
}

async function search(db: AquillaDb, query: Record<string, string>): Promise<Hit[]> {
  const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: "any" })
  const params = new URLSearchParams(query)
  const req = new Request(`https://w/api/v1/projects/${PROJECT}/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const res = (await handleSearchReadRequest(req, { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
  expect(res.status).toBe(200)
  return ((await res.json()) as { results: Hit[] }).results
}

const ids = (hits: Hit[]) => hits.map((h) => h.cellId)

describe("search in scripts the word index cannot search", () => {
  it("finds a Chinese term inside a longer clause", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell("2ki", "v1", "target", KINGS_1_1),
        cell("2ki", "v2", "target", KINGS_12_13),
        cell("2ki", "v3", "target", KINGS_25_14),
      ],
    })
    expect(ids(await search(db, { q: "器皿" })).sort()).toEqual(["v2", "v3"])
  })

  it("marks the term in the snippet", async () => {
    const { db } = await makeTestDb({ cells: [cell("2ki", "v3", "target", KINGS_25_14)] })
    const [hit] = await search(db, { q: "器皿" })
    expect(hit.snippet).toContain("<mark>器皿</mark>")
  })

  it("returns every cell with the term, not only the ones where punctuation isolates it", async () => {
    // 、器皿、 makes 器皿 a word of its own, so the word index DOES hold it for
    // this one cell. Answering from the index would return this cell alone and
    // look like a complete result.
    const { db } = await makeTestDb({
      cells: [
        cell("2ki", "v1", "target", "金器、器皿、銀器"),
        cell("2ki", "v2", "target", KINGS_12_13),
      ],
    })
    expect(ids(await search(db, { q: "器皿" })).sort()).toEqual(["v1", "v2"])
  })

  it.each([
    ["Thai", "ภาชนะ", "และภาชนะทองสัมฤทธิ์ทั้งสิ้นซึ่งใช้ในการปรนนิบัติ"],
    ["Burmese", "တန်ဆာ", "အမှုတော်ဆောင်ရာတွင်သုံးသောကြေးဝါတန်ဆာရှိသမျှတို့ကို"],
    ["Japanese", "うつわ", "また務めに用いる青銅のうつわをことごとく取った"],
    ["Khmer", "ប្រដាប់", "និងប្រដាប់លង្ហិនទាំងប៉ុន្មានដែលសម្រាប់ប្រើការងារ"],
    ["Lao", "ພາຊະນະ", "ແລະພາຊະນະທອງສຳຣິດທັງໝົດທີ່ໃຊ້ໃນການບົວລະບັດ"],
    ["Korean", "하나님", GEN_1_1],
  ])("finds a %s term inside a longer run", async (_script, term, verse) => {
    const { db } = await makeTestDb({
      cells: [cell("f", "hit", "target", verse), cell("f", "miss", "target", KINGS_1_1)],
    })
    expect(ids(await search(db, { q: term }))).toEqual(["hit"])
  })

  it("keeps the paired side and respects the side filter", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell("2ki", "v3", "source", "and all the vessels of bronze"),
        cell("2ki", "v3", "target", KINGS_25_14),
      ],
    })
    const [hit] = await search(db, { q: "器皿" })
    expect(hit.side).toBe("target")
    expect(hit.pairedValue).toBe("and all the vessels of bronze")
    expect(await search(db, { q: "器皿", side: "source" })).toEqual([])
  })

  it("honours the lane read wall", async () => {
    const { db } = await makeTestDb({
      lanes: [
        { id: "lane-a", project_id: PROJECT, role: "target", name: "A", lang_code: "zh-Hant", legacy_tag: "" },
        { id: "lane-b", project_id: PROJECT, role: "target", name: "B", lang_code: "zh-Hans", legacy_tag: "zh-Hans" },
      ],
      cells: [
        cell("2ki", "v3", "source", "and all the vessels of bronze 器皿"),
        cell("2ki", "v3", "target", KINGS_25_14, { lane_id: "lane-a", event_id: "e-a" }),
        cell("2ki", "v3", "target", "又带去锅、铲子、蜡剪、调羹，并所用的一切铜器皿，", { lane_id: "lane-b", event_id: "e-b" }),
      ],
    })
    const walled = await queryScopedSearch(db, project, "器皿", { laneIds: ["lane-a"] })
    const seen = walled.flatMap((h) => [h.value, h.pairedValue ?? ""]).join("|")
    expect(seen).toContain(KINGS_25_14)
    // Neither as a hit of its own nor as the paired side of the source hit.
    expect(seen).not.toContain("并所用的一切铜器皿")
    expect(await queryScopedSearch(db, project, "器皿", { laneIds: null })).toHaveLength(3)
  })

  it("leaves parked cells, deleted files and hidden companions out", async () => {
    const { db } = await makeTestDb({
      files: [
        { id: "2ki", project_id: PROJECT, name: "2 Kings", event_id: "fe1" },
        { id: "gone", project_id: PROJECT, name: "Deleted", event_id: "fe2", deleted_at: 1_700_000_000_000 },
        { id: "cues", project_id: PROJECT, name: "Cues", event_id: "fe3", role: "audio-cues" },
      ],
      cells: [
        cell("2ki", "v2", "source", "silver vessels"),
        cell("2ki", "v2", "target", KINGS_12_13),
        cell("2ki", "v3", "source", "bronze vessels", { hidden_at: 1_700_000_000_000 }),
        cell("2ki", "v3", "target", KINGS_25_14),
        cell("gone", "g1", "target", KINGS_25_14),
        cell("cues", "q1", "target", KINGS_25_14),
      ],
    })
    expect(ids(await search(db, { q: "器皿" }))).toEqual(["v2"])
  })

  it("finds an exact phrase for parallel passages, with its paired side", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell("2ki", "v3", "source", "and all the vessels of bronze"),
        cell("2ki", "v3", "target", KINGS_25_14),
        cell("2ki", "v2", "target", KINGS_12_13),
      ],
    })
    const hits = await queryScopedExact(db, project, "一切銅器皿", { laneIds: null })
    expect(hits.map((h) => [h.cellId, h.pairedValue])).toEqual([["v3", "and all the vessels of bronze"]])
  })

  it("keeps an exact phrase whole: its words apart are not the phrase", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell("gen", "v1", "target", GEN_1_1),
        cell("gen", "v27", "target", GEN_1_27),
      ],
    })
    // Both cells hold 하나님이 and 창조; only 1:1 holds this run of text.
    const hits = await queryScopedExact(db, project, "하나님이 천지를", { laneIds: null })
    expect(hits.map((h) => h.cellId)).toEqual(["v1"])
  })
})

describe("Korean", () => {
  async function genesis() {
    return makeTestDb({
      cells: [
        cell("gen", "v01", "target", GEN_1_1),
        cell("gen", "v02", "target", GEN_1_2),
        cell("gen", "v05", "target", GEN_1_5),
        cell("gen", "v27", "target", GEN_1_27),
        cell("gen", "v2-4", "target", GEN_2_4),
      ],
    })
  }

  it("finds a noun under every particle it is written with", async () => {
    // 하나님이, 하나님의, 하나님께서: three different words to a word index,
    // none of them 하나님.
    const { db } = await genesis()
    expect(ids(await search(db, { q: "하나님" })).sort()).toEqual(["v01", "v02", "v2-4", "v27"])
  })

  it("finds a verb stem under its endings", async () => {
    const { db } = await genesis()
    expect(ids(await search(db, { q: "창조" })).sort()).toEqual(["v01", "v27"])
  })

  it("still finds a word typed in full", async () => {
    const { db } = await genesis()
    expect(ids(await search(db, { q: "하나님께서" }))).toEqual(["v2-4"])
  })

  it("wants every typed word, in any order", async () => {
    const { db } = await genesis()
    expect(ids(await search(db, { q: "창조 하나님" })).sort()).toEqual(["v01", "v27"])
    expect(await search(db, { q: "하나님 저녁" })).toEqual([])
  })

  it("marks each typed word in the snippet", async () => {
    const { db } = await genesis()
    const [hit] = await search(db, { q: "하나님 천지" })
    expect(hit.snippet).toBe("태초에 <mark>하나님</mark>이 <mark>천지</mark>를 창조하시니라")
  })
})

describe("relevance order for text-matched results", () => {
  it("puts the cell that says it most first", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell("f", "a-once", "target", "聖殿的器皿"),
        cell("f", "b-thrice", "target", "金器皿、銀器皿、銅器皿"),
        cell("f", "c-twice", "target", "器皿和器皿"),
      ],
    })
    const hits = await search(db, { q: "器皿" })
    expect(ids(hits)).toEqual(["b-thrice", "c-twice", "a-once"])
    expect(hits.map((h) => h.rank)).toEqual([3, 2, 1])
  })

  it("keeps equal hits in reading order, not id order", async () => {
    // Ids sort zeta > mid > alpha; the file reads zeta, alpha, mid.
    const { db } = await makeTestDb({
      cells: [
        cell("f", "zeta", "source", "one", { sequence_index: 1 }),
        cell("f", "alpha", "source", "two", { sequence_index: 2 }),
        cell("f", "mid", "source", "three", { sequence_index: 3 }),
        cell("f", "alpha", "target", "第二節的器皿"),
        cell("f", "mid", "target", "第三節的器皿"),
        cell("f", "zeta", "target", "第一節的器皿"),
      ],
    })
    expect(ids(await search(db, { q: "器皿" }))).toEqual(["zeta", "alpha", "mid"])
    // And the same list every time it is asked for.
    expect(ids(await search(db, { q: "器皿" }))).toEqual(["zeta", "alpha", "mid"])
  })

  it("reads a migrated file in verse order: no sequence index, only references", async () => {
    // A project migrated from Codex has `sequence_index` NULL on every cell.
    // Found walking a real one: 2 Kings came back 4:3, 12:13, 4:4, which is
    // cell-id order. As text, "12:13" also sorts before "4:3", and "4:10"
    // before "4:3"; the numbers have to be compared as numbers.
    const { db } = await makeTestDb({
      cells: [
        cell("2ki", "c-3c", "source", "借空器皿", { canonical_ref: "2KI 4:3" }),
        cell("2ki", "c-5a", "source", "金银器皿", { canonical_ref: "2KI 12:13" }),
        cell("2ki", "c-60", "source", "借来的器皿中", { canonical_ref: "2KI 4:4" }),
        cell("2ki", "c-1f", "source", "一切的器皿", { canonical_ref: "2KI 4:10" }),
        cell("2ki", "c-00", "source", "器皿的標題", { canonical_ref: "2KI" }),
        cell("2ki", "c-ba", "source", "器皿都装满了，再拿个器皿", { canonical_ref: "2KI 4:6" }),
        // A translated verse has no reference of its own: its source row's counts.
        cell("2ki", "c-zz", "source", "a verse about something else", { canonical_ref: "2KI 4:2" }),
        cell("2ki", "c-zz", "target", "譯文裡的器皿"),
      ],
    })
    const hits = await search(db, { q: "器皿" })
    expect(hits.map((h) => (h as Hit & { canonicalRef: string | null }).canonicalRef)).toEqual([
      "2KI 4:6", // says it twice
      "2KI 4:2",
      "2KI 4:3",
      "2KI 4:4",
      "2KI 4:10",
      "2KI 12:13",
      "2KI", // no chapter or verse: after the verses
    ])
  })

  it("sums every typed word", async () => {
    const { db } = await makeTestDb({
      cells: [cell("gen", "v01", "target", GEN_1_1), cell("gen", "v27", "target", GEN_1_27)],
    })
    // 1:27 says 하나님 twice and 창조 twice; 1:1 says each once.
    const hits = await search(db, { q: "하나님 창조" })
    expect(hits.map((h) => [h.cellId, h.rank])).toEqual([["v27", 4], ["v01", 2]])
  })

  it("puts a cell holding the query exactly as typed above one that repeats its words", async () => {
    const scattered = "천지를 지으신 이는 하나님이시요 천지를 다스리시는 이도 하나님이시라"
    const { db } = await makeTestDb({
      cells: [cell("gen", "a-scattered", "target", scattered), cell("gen", "b-exact", "target", GEN_1_1)],
    })
    const hits = await search(db, { q: "하나님이 천지를" })
    expect(hits.map((h) => [h.cellId, h.rank])).toEqual([["b-exact", 2], ["a-scattered", 4]])
  })

  it("fills a short page with the best hits, not the first ones", async () => {
    const cells: SeedCell[] = []
    for (let i = 0; i < 60; i++) {
      cells.push(cell("f", `a-${String(i).padStart(2, "0")}`, "target", `第${i}節的器皿`))
    }
    cells.push(cell("zz", "zz-most", "target", "金器皿、銀器皿、銅器皿"))
    const { db } = await makeTestDb({ cells })
    const hits = await search(db, { q: "器皿" })
    expect(hits).toHaveLength(50)
    expect(hits[0].cellId).toBe("zz-most")
  })
})

describe("every other script stays on the word index", () => {
  // The tell is a partial word: the word index does not match inside a word,
  // text matching would. Each row pins both halves for one script, so a
  // script slipping onto the text path fails here rather than in production.
  it.each([
    ["English", "In the beginning God created", "begin", "beginning"],
    ["French", "Au commencement Dieu créa les cieux", "commence", "commencement"],
    ["Spanish", "En el principio creó Dios los cielos", "princip", "principio"],
    ["Russian", "В начале сотворил Бог небо и землю", "нача", "начале"],
    ["Greek", "εν αρχη εποιησεν ο θεος τον ουρανον", "ουραν", "ουρανον"],
    ["Hebrew", "בראשית ברא אלהים את השמים", "אלה", "אלהים"],
    ["Arabic", "في البدء خلق الله السماوات والارض", "السماو", "السماوات"],
    ["Amharic", "በመጀመሪያ እግዚአብሔር ሰማይንና ምድርን ፈጠረ", "እግዚ", "እግዚአብሔር"],
  ])("%s", async (_language, verse, partial, whole) => {
    const { db } = await makeTestDb({ cells: [cell("gen", "v1", "source", verse)] })
    expect(await search(db, { q: partial })).toEqual([])
    expect(ids(await search(db, { q: whole }))).toEqual(["v1"])
  })

  async function english() {
    return makeTestDb({
      cells: [
        cell("gen", "v1", "source", "In the beginning God created the heavens and the earth"),
        cell("gen", "v2", "source", "The earth was without form, and void"),
        cell("gen", "v3", "source", "And God said, Let there be light: and there was light"),
      ],
    })
  }

  it("wants every word, in any order, whatever its case", async () => {
    const { db } = await english()
    expect(ids(await search(db, { q: "created God" }))).toEqual(["v1"])
    expect(ids(await search(db, { q: "GOD" })).sort()).toEqual(["v1", "v3"])
    expect(await search(db, { q: "God void" })).toEqual([])
  })

  it("ranks by the index's own score and marks whole words", async () => {
    const { db } = await english()
    const hits = await search(db, { q: "light" })
    expect(ids(hits)).toEqual(["v3"])
    expect(hits[0].snippet).toContain("<mark>light</mark>")
    // ts_rank is a fraction; the text path's count is a whole number.
    expect(hits[0].rank).toBeGreaterThan(0)
    expect(hits[0].rank).toBeLessThan(1)

    const more = await search(db, { q: "earth" })
    expect(ids(more).sort()).toEqual(["v1", "v2"])
  })

  it("puts the cell with more mentions first", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell("f", "a-once", "source", "the vessels of the house"),
        cell("f", "b-thrice", "source", "vessels of gold, vessels of silver, vessels of bronze"),
      ],
    })
    expect(ids(await search(db, { q: "vessels" }))).toEqual(["b-thrice", "a-once"])
  })
})

describe("search scoped to one file", () => {
  // 2 Kings holds two hits; sixty other files hold one each. The page is 50.
  async function bible() {
    const cells: SeedCell[] = []
    for (let i = 0; i < 60; i++) {
      const id = `book-${String(i).padStart(2, "0")}`
      cells.push(cell(id, `a-${id}`, "target", "the vessels of the house"))
      cells.push(cell(id, `z-${id}`, "target", `聖殿的器皿 ${i}`))
    }
    cells.push(cell("zz-2ki", "zz-v2", "target", KINGS_12_13))
    cells.push(cell("zz-2ki", "zz-v3", "target", KINGS_25_14))
    cells.push(cell("zz-2ki", "zz-en1", "target", "all the vessels of bronze"))
    cells.push(cell("zz-2ki", "zz-en2", "target", "vessels of gold and vessels of silver"))
    return makeTestDb({ cells })
  }

  it("returns the file's hits when the project has more hits than one page", async () => {
    const { db } = await bible()
    expect(ids(await search(db, { q: "器皿", fileId: "zz-2ki" })).sort()).toEqual(["zz-v2", "zz-v3"])
  })

  it("does the same for a word-index query", async () => {
    const { db } = await bible()
    expect(ids(await search(db, { q: "vessels", fileId: "zz-2ki" })).sort()).toEqual(["zz-en1", "zz-en2"])
  })

  it("does the same for a flagged (match case) query", async () => {
    const { db } = await bible()
    expect(ids(await search(db, { q: "vessels", fileId: "zz-2ki", case: "1" })).sort()).toEqual(["zz-en1", "zz-en2"])
  })

  it("holds end to end: the browser's own request, through the real route", async () => {
    // The two halves agree on the param only if one test sends what the
    // client really builds to the code that really reads it.
    const { db } = await bible()
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: "any" })
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      (await handleSearchReadRequest(new Request(input, init), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!) as typeof fetch
    try {
      const inFile = await fetchProjectSearch(PROJECT, "器皿", { fileId: "zz-2ki" }, token)
      expect(inFile.map((h) => h.cellId).sort()).toEqual(["zz-v2", "zz-v3"])
      const inProject = await fetchProjectSearch(PROJECT, "器皿", {}, token)
      expect(inProject).toHaveLength(50)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("returns nothing for a file with no hits rather than falling back to the project", async () => {
    const { db } = await bible()
    expect(await search(db, { q: "器皿", fileId: "no-such-file" })).toEqual([])
  })
})
