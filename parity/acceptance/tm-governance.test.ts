// Adversarial acceptance tests for TM governance (F6, C8).
// One canary leak = the row fails, regardless of every other number.
import { describe, it, expect } from "vitest"
import {
  GlobalTmIndex,
  InMemoryGlobalTmStore,
  type GlobalTmEntry,
  type GovernanceResolvers,
} from "@/lib/global-tm/index"
import {
  resolveProjectEntitlements,
  isEnterpriseOrg,
  PAID_FEATURES,
  type BillingStub,
} from "@/lib/entitlements/entitlements"
import { BatchStubServer } from "../batch/stub-server"

// ─── seeded world ────────────────────────────────────────────────────────────

const ENT_CANARIES = [
  "CANARY-ENT-ALPHA-7f3e confidential enterprise clause",
  "The merger agreement CANARY-ENT-BRAVO-2c91 must remain sealed",
  "CANARY-ENT-CHARLIE-e04d internal pricing schedule",
]
const OPTOUT_CANARIES = [
  "CANARY-OPTOUT-DELTA-9d2c proprietary medical protocol",
  "Dosage table CANARY-OPTOUT-ECHO-51aa for restricted trial",
]

interface World {
  index: GlobalTmIndex
  store: InMemoryGlobalTmStore
}

function seedWorld(): World {
  const enterpriseOrgs = new Set(["org-ent-1", "org-ent-2"])
  const optedOutProjects = new Set(["proj-optout-1"])
  const governance: GovernanceResolvers = {
    isEnterpriseOrg: (orgId) => enterpriseOrgs.has(orgId),
    isOptedOutProject: (projectId) => optedOutProjects.has(projectId),
  }
  const store = new InMemoryGlobalTmStore()
  const index = new GlobalTmIndex(store, governance)
  let id = 0
  const add = (source: string, target: string, projectId: string, orgId: string, langs: [string, string] = ["en-US", "fr-FR"]): void => {
    // Direct store insert: the seeded DB state, including rows that predate
    // any flag change — retrieval alone must keep them unreachable.
    store.unsafeInsertDirect({
      id: `e${++id}`,
      source,
      target,
      sourceLang: langs[0],
      targetLang: langs[1],
      projectId,
      orgId,
    })
  }
  // normal orgs: realistic validated pairs
  const normals: [string, string][] = [
    ["Click Save to apply your changes.", "Cliquez sur Enregistrer pour appliquer vos modifications."],
    ["The invoice is due within 30 days.", "La facture est payable sous 30 jours."],
    ["Do not exceed the recommended dose.", "Ne dépassez pas la dose recommandée."],
    ["This warranty does not cover misuse.", "Cette garantie ne couvre pas les mauvais usages."],
    ["Battery life up to 18 hours.", "Autonomie jusqu'à 18 heures."],
    ["Sign in to continue.", "Connectez-vous pour continuer."],
  ]
  normals.forEach(([s, t], i) => add(s, t, `proj-normal-${i % 3}`, `org-normal-${i % 3}`))
  // enterprise canaries in BOTH directions and cross-language variants
  for (const c of ENT_CANARIES) {
    add(c, `FR ${c}`, "proj-ent-1", "org-ent-1")
    add(`Prefix ${c} suffix`, `FR ${c}`, "proj-ent-2", "org-ent-2")
    add(c, `DE ${c}`, "proj-ent-1", "org-ent-1", ["en-US", "de-DE"])
    add(`FR ${c}`, c, "proj-ent-1", "org-ent-1", ["fr-FR", "en-US"])
  }
  // opted-out project canaries (rows exist = simulated legacy/bug rows)
  for (const c of OPTOUT_CANARIES) {
    add(c, `FR ${c}`, "proj-optout-1", "org-normal-0")
  }
  return { index, store }
}

const leaks = (results: GlobalTmEntry[]): GlobalTmEntry[] =>
  results.filter(
    (r) =>
      r.orgId.startsWith("org-ent") ||
      r.projectId === "proj-optout-1" ||
      /CANARY-(ENT|OPTOUT)/.test(r.source) ||
      /CANARY-(ENT|OPTOUT)/.test(r.target),
  )

// deterministic PRNG for the property-based sweep
const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return (): number => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("TM governance — enterprise exclusion (F6)", () => {
  it("[tm.enterprise.exclusion] property-based: 500 randomized queries never surface an enterprise-origin entry", () => {
    const { index } = seedWorld()
    const rng = mulberry32(0xf6f6f6)
    const vocab = [
      "confidential", "enterprise", "clause", "merger", "agreement", "sealed", "internal",
      "pricing", "schedule", "canary", "alpha", "bravo", "charlie", "save", "invoice",
      "dose", "warranty", "battery", "CANARY-ENT-ALPHA-7f3e", "CANARY-ENT-BRAVO-2c91",
      "CANARY-ENT-CHARLIE-e04d", "7f3e", "2c91", "e04d",
    ]
    const pairs: [string, string][] = [
      ["en-US", "fr-FR"], ["en-US", "de-DE"], ["fr-FR", "en-US"], ["en-us", "fr-fr"],
    ]
    for (let i = 0; i < 500; i++) {
      const n = 1 + Math.floor(rng() * 6)
      const query = Array.from({ length: n }, () => vocab[Math.floor(rng() * vocab.length)]).join(" ")
      const [sl, tl] = pairs[Math.floor(rng() * pairs.length)]
      const results = index.retrieve({ query, sourceLang: sl, targetLang: tl, limit: 1 + Math.floor(rng() * 10) })
      expect(leaks(results)).toEqual([])
    }
  })

  it("[tm.enterprise.exclusion] red-team: exact, near-match, substring and cross-language canary probes all come back empty", () => {
    const { index } = seedWorld()
    for (const canary of ENT_CANARIES) {
      // exact
      expect(leaks(index.retrieve({ query: canary, sourceLang: "en-US", targetLang: "fr-FR", limit: 10 }))).toEqual([])
      // near-match (token swapped)
      const near = canary.replace(/\b\w+$/, "document")
      expect(leaks(index.retrieve({ query: near, sourceLang: "en-US", targetLang: "fr-FR", limit: 10 }))).toEqual([])
      // marker-only substring
      const marker = /CANARY-ENT-\w+-\w+/.exec(canary)?.[0] as string
      expect(leaks(index.retrieve({ query: marker, sourceLang: "en-US", targetLang: "fr-FR", limit: 10 }))).toEqual([])
      // cross-language: canary text queried on the pair where it is the SOURCE of a reversed entry
      expect(leaks(index.retrieve({ query: `FR ${canary}`, sourceLang: "fr-FR", targetLang: "en-US", limit: 10 }))).toEqual([])
      // other language pair carrying the canary
      expect(leaks(index.retrieve({ query: canary, sourceLang: "en-US", targetLang: "de-DE", limit: 10 }))).toEqual([])
    }
    // normal content still retrievable — the filter is not "return nothing"
    const normal = index.retrieve({ query: "Click Save to apply", sourceLang: "en-US", targetLang: "fr-FR", limit: 5 })
    expect(normal.length).toBeGreaterThan(0)
  })
})

describe("TM governance — opt-out (C8)", () => {
  it("[tm.optout.write-gate] contribute() refuses writes when the effective flag is false; default is TRUE; paid gating applies", () => {
    const { index, store } = seedWorld()
    const before = store.size()

    // default TRUE (setting absent)
    const defaultEnt = resolveProjectEntitlements({ orgId: "org-normal-0", orgSettings: {}, projectSettings: {} })
    expect(defaultEnt.contributeToGlobalTm).toBe(true)

    // explicit opt-out with the paid feature (stub grants) → write refused
    const optedOut = resolveProjectEntitlements({
      orgId: "org-normal-0",
      orgSettings: {},
      projectSettings: { contributeToGlobalTm: false },
    })
    expect(optedOut.contributeToGlobalTm).toBe(false)
    const refused = index.contribute(
      { id: "w1", source: "secret", target: "secret-fr", sourceLang: "en-US", targetLang: "fr-FR", projectId: "proj-optout-1", orgId: "org-normal-0" },
      { projectId: "proj-optout-1", orgId: "org-normal-0", contributeToGlobalTm: optedOut.contributeToGlobalTm },
    )
    expect(refused).toBe(false)
    expect(store.size()).toBe(before) // zero writes

    // without the paid feature the opt-out cannot take effect (C8: paid gate)
    const noBilling: BillingStub = { hasPaidFeature: () => false }
    const unentitled = resolveProjectEntitlements({
      orgId: "org-normal-0",
      orgSettings: {},
      projectSettings: { contributeToGlobalTm: false },
      billing: noBilling,
    })
    expect(unentitled.contributeToGlobalTm).toBe(true)
    expect(unentitled.canConfigureTmOptOut).toBe(false)

    // contributing project writes fine
    const ok = index.contribute(
      { id: "w2", source: "public", target: "public-fr", sourceLang: "en-US", targetLang: "fr-FR", projectId: "proj-normal-0", orgId: "org-normal-0" },
      { projectId: "proj-normal-0", orgId: "org-normal-0", contributeToGlobalTm: true },
    )
    expect(ok).toBe(true)
    expect(store.size()).toBe(before + 1)

    // enterprise flag reader
    expect(isEnterpriseOrg({ enterprise: true })).toBe(true)
    expect(isEnterpriseOrg({})).toBe(false)
    expect(PAID_FEATURES.globalTmOptOut).toBe("global-tm-opt-out")
  })

  it("[tm.optout.leak-test] canaries of an opted-out project are unreachable even when rows exist in the store", () => {
    const { index } = seedWorld() // seeding put opt-out canary ROWS directly in the store
    for (const canary of OPTOUT_CANARIES) {
      expect(leaks(index.retrieve({ query: canary, sourceLang: "en-US", targetLang: "fr-FR", limit: 10 }))).toEqual([])
      const marker = /CANARY-OPTOUT-\w+-\w+/.exec(canary)?.[0] as string
      expect(leaks(index.retrieve({ query: marker, sourceLang: "en-US", targetLang: "fr-FR", limit: 10 }))).toEqual([])
      const near = canary.replace(/\b\w+$/, "study")
      expect(leaks(index.retrieve({ query: near, sourceLang: "en-US", targetLang: "fr-FR", limit: 10 }))).toEqual([])
    }
  })
})

describe("TM governance — batch integration", () => {
  it("[batch.fewshot] the batch pipeline wired to the real index never receives enterprise or opted-out examples", async () => {
    const { index } = seedWorld()
    const seen: string[] = []
    const server = new BatchStubServer({
      retrieveExamples: async ({ query, sourceLang, targetLang, limit }) => {
        const entries = index.retrieve({ query, sourceLang, targetLang, limit })
        seen.push(...entries.map((e) => `${e.orgId}/${e.projectId}`))
        return entries.map((e) => ({ source: e.source, target: e.target, projectId: e.projectId, orgId: e.orgId }))
      },
    })
    const created = await server.handle({
      method: "POST",
      path: "/batch/v1/batches",
      headers: { "x-aquilla-key": "test_a.b" },
      body: {
        projectId: "proj-normal-0",
        sourceLang: "en-US",
        targetLang: "fr-FR",
        segments: [
          { id: "s1", text: "CANARY-ENT-ALPHA-7f3e confidential enterprise clause" },
          { id: "s2", text: "Click Save to apply your changes." },
          { id: "s3", text: "CANARY-OPTOUT-DELTA-9d2c proprietary medical protocol" },
        ],
        options: { maxExamplesPerSegment: 5 },
      },
    })
    expect(created.status).toBe(202)
    await server.drain()
    expect(seen.some((s) => s.includes("org-ent") || s.includes("proj-optout"))).toBe(false)
    // and the normal segment did get examples
    const results = await server.handle({
      method: "GET",
      path: (created.body as { resultsUrl: string }).resultsUrl,
      headers: { "x-aquilla-key": "test_a.b" },
    })
    const rs = (results.body as { results: { id: string; examplesUsed: number }[] }).results
    expect(rs.find((r) => r.id === "s2")?.examplesUsed ?? 0).toBeGreaterThan(0)
  })
})
