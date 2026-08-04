# pSEO + AEO strategy — the graph and the routine

*July 2026. Companion to `docs/SEO.md` (the build-time prerender mechanics), the ICP doc, and
the Verbatim Call-Out Kit. This document is the strategy; `docs/SEO.md` is the plumbing.*

> **This is the longer-range plan.** If you're starting SEO work on the site, read
> `docs/SEO-WORKPLAN.md` first and finish its Phases 0–3 — search console access, the defects on
> the pages that already exist, and real query data. None of what follows can be steered without
> those.

---

## 0. The verdict, before the plan

**Retrieval is the whole problem, and the market is too small and too easy to burn for
conventional pSEO.** Those two facts pull in opposite directions and the strategy is the
resolution: build a *graph* of things that are genuinely different from each other, publish
only the nodes that clear a loss function, and let a *routine* walk the graph forever.

Three findings from the audit drive everything below.

**Finding 1 — organic search is 2% of traffic.** PostHog, last 90 days, by initial channel:

| Channel | Visitors | Pageviews | Share of visitors |
|---|---|---|---|
| Direct | 237 | 3,914 | 77% |
| Referral | 63 | 637 | 21% |
| **Organic Search** | **6** | **9** | **2%** |
| Email | 1 | 1 | <1% |

Six organic visitors in a quarter. The site had no `sitemap.xml`, a `robots.txt` with one
`Disallow` line and nothing else, and every marketing page shipped a ~230-character stub to
crawlers. That last part is now fixed (see `docs/SEO.md`), which means the floor just moved —
but there is still essentially nothing to retrieve.

**Finding 2 — the AI answer for your category is already your argument, credited to others.**
Probing *"how to translate ministry curriculum into other languages AI without replacing
translators"* returns: AI drafts, humans verify, consultants can't be replaced, low-resource
languages lack trained linguists so AI gets used for checking. That is the Aquilla thesis
almost verbatim. Cited: Religion Unplugged, OneAccord, an Oral Roberts University library
guide, Lokalise, Wordly, InOtherWord. **Not a single vendor homepage in the citation set** —
the engines cite editorial, directory, and library-guide pages. That is the Layer 2 lesson and
it is free.

**Finding 3 — the category term retrieves the wrong product class.** *"AI Bible translation
software for ministries"* returns live sermon translation (OneAccord, Glossa, Wordly, Sermon
Live) plus Scripture Forge. Fighting for that phrase means competing on a category you don't
serve, against products with app-store surface area. **Do not chase it.** The buyer in the ICP
doc does not search that phrase; they search the thing in front of them.

### Three-layer score

| Layer | Score | Evidence |
|---|---|---|
| **1 — Retrieval** | **Weak** | 6 organic visitors/90d. No sitemap until now. 5 marketing URLs total. Nothing indexable at depth. |
| **2 — Source Preference** | **Weak** | Absent from every source type the engines cited: no directory listings, no encyclopedic footprint, no community presence, no third-party editorial. |
| **3 — Selection** | **Partial** | Two strong named case studies (Biblica, Come and See) with real, verifiable outcomes — the rarest asset in this sector. But nothing to select *from*, because layers 1 and 2 keep you out of the pool. |

Sequence follows dependency: **Retrieval → Source Preference → Selection.** Selection work is
wasted until there is something in the pool.

---

## 1. Why classic pSEO is wrong here, and what replaces it

The orthodox move is 5,000 templated pages. Three reasons that fails for this business:

1. **The buyer population is tiny.** A few thousand people worldwide own translation at a
   mission-driven org. You cannot out-volume your way to them; there is no volume.
2. **The network punishes farming.** The ICP doc is explicit: this market is "easy to burn,"
   and content here works as *recognition*, not persuasion. A page farm is legible as farming
   within one conversation at ICCM.
3. **The vocabulary is disjoint.** Ministry buyers don't say TMS, MQM, per-word, or fuzzy
   match. Templated localization-industry pages retrieve the wrong audience — the one where
   Smartling and Phrase beat you in two quarters.

**So the scale target is not the buyer. It is the engine.** The pages exist to put Aquilla in
the candidate pool for the long-tail factual questions that LLMs and crawlers must resolve, and
to be genuinely useful to the handful of humans who land on each one. That reframing is what
makes the two-question test passable at scale here: these pages would be useful with no search
engine, because **the sector has no reference layer at all.** Nobody has built it. That is the
whole opportunity.

### The two-question test, run explicitly

> 1. Useful if search engines didn't exist? 2. Worth bookmarking and returning to?

| Page family | Q1 | Q2 | Why |
|---|---|---|---|
| **Language brief** (`/library/language/:iso`) | ✅ | ✅ | A project lead scoping a new language has nowhere to get script/font/tone-mark/corpus/TTS reality in one place. They will re-open it every time they scope. |
| **Format brief** (`/library/format/:slug`) | ✅ | ✅ | "Can we output back to USFM? How do we copy-paste?" is a literal customer question with no good answer anywhere. Round-trip fidelity is checkable and re-checked. |
| **Question brief** (`/library/question/:slug`) | ✅ | ✅ | The buyer's own stated problem is "I don't even know what questions to ask." A page that *is* the answer to one of those questions is the product of the Pillar 4 promise. |
| **Concept bridge** (`/library/term/:slug`) | ✅ | ⚠️ | Useful once, less bookmarkable. **Gate harder** — only publish where the ministry↔localization translation genuinely differs. |
| ~~Org/customer pages~~ | ❌ | ❌ | **Do not build.** Thin, and it implies customer relationships you can't claim. Cut. |
| ~~"Aquilla vs X" at scale~~ | ❌ | — | One honest comparison page, hand-written. Not a family. See §6. |

---

## 2. The graph

One graph. It is simultaneously the pSEO taxonomy, the internal-linking architecture, the AEO
entity footprint, and the iteration state. That fourfold duty is why it's a graph and not a
flat niche list.

### Node types

```jsonc
// content/graph/languages.json — one entry per node
{
  "id": "lang:lua",                    // ISO 639-3
  "type": "language",
  "name": "Chiluba",
  "register": "ministry",              // ministry | localization | both — governs vocabulary
  "facts": {                            // ≥3 independent, node-specific facts required
    "script": "Latin",
    "tone_marked": true,
    "speakers_est": 6300000,
    "scripture_status": "…",
    "corpora": ["ebible:lua", "…"],
    "tts_available": false,
    "asr_available": false
  },
  "edges": {
    "formats": ["fmt:usfm", "fmt:usx"],
    "concepts": ["term:tone-marks", "term:low-resource"],
    "questions": ["q:no-tts-for-my-language"],
    "pains": ["pain:tone-marks-meaning-lost"],   // allowlisted verbatim only
    "proof": []
  },
  "sources": [{ "label": "…", "url": "…" }],     // ≥1 primary source required
  "two_question_test": "A lead scoping Chiluba needs tone-mark handling + corpus availability in one place; re-checked each project.",
  "status": "draft"                    // draft | published | refract | retired
}
```

Six node files: `languages`, `formats`, `concepts`, `questions`, `pains`, `proof`.
Edges are declared on the node and symmetrised at build time.

### Why a graph earns its keep

- **Internal linking falls out of it.** Every published node links to its edge targets; every
  hub page clusters its family. Crawl priority within a cluster is the single cheapest
  indexing lever in the pSEO playbook, and here it's free — it's a graph traversal.
- **It *is* the entity footprint.** AEO selection rewards consistent co-mention. A graph that
  reliably places Aquilla adjacent to *Paratext · USFM · consultant check · back translation ·
  mother-tongue translator · ISO 639-3 · print-ready typeset* teaches every engine what
  Aquilla is adjacent to. That's entity stacking, expressed as data.
- **It encodes the vocabulary firewall.** `register` on every node enforces ICP §5 mechanically:
  `ministry` nodes never emit localization beacons (TMS, MQM, per-word, XLIFF, `#l10n`) into
  copy. The `both`-register nodes with an edge from ministry to localization are the
  *interpreter* position the ICP identifies as unclaimed — "your glossary is what the industry
  calls a termbase, and here's why theirs is enforced and yours isn't."
- **It gives the routine something to walk.** Iteration = graph traversal + loss function. See §5.

### Where the graph comes from — you already own the raw material

| Graph input | Source you already have |
|---|---|
| `languages` | `src/lib/language-normalize.ts`, `src/lib/dcs/lang-seed.ts`, eBible/Macula/HelloAO/OBS parser coverage, ISO 639-3, Ethnologue, All Access Goals |
| `formats` | ~20 parsers in `src/lib/parsers/` — USFM, USX, Paratext projects, IDML, DOCX, CSV bilingual, JSON-i18n, Markdown, HTML, OBS, label tracks |
| `questions` | The 17-call corpus. Every literal customer question is a node. |
| `pains` | The Verbatim Call-Out Kit §10 — **the 12 cleared lines only** |
| `concepts` | ICP §5 say-these list (34 ministry beacons) × the avoid-these list, paired |
| `proof` | Biblica + Come and See case studies; Pieter's measured "half to two-thirds of the time" |

**Sizing.** Do not generate 7,400 language pages. Gate on data density: publish a language node
only when it carries ≥3 node-specific facts and ≥1 primary source. That is realistically
**300–800 languages**, not thousands. Formats: **20–40**. Questions: **60–120**. Concepts:
**20–30**. Call it **400–1,000 pages at full build**, reached over four quarters, not one sprint.

---

## 3. Interactive components — the anti-slop mechanism

Every page carries one component tied to a named outcome. This is what keeps the pages from
being a wall of generated text, and it is the difference between passing and failing the
two-question test.

| Page family | The outcome the user wants | Component |
|---|---|---|
| Language brief | "Tell me what my project in this language will actually hit" | **Project reality checker** — script/font, tone marks, corpus availability, TTS/ASR, reviewer scarcity, each with a red/amber/green and a one-line "what to do about it" |
| Format brief | "Will my content survive the round trip?" | **Round-trip fidelity matrix** — element × in/out × preserved/degraded/lost, generated from the actual parser test fixtures. This is checkable and it is true. |
| Question brief | "Answer my question and tell me what I didn't think to ask" | **Answer-first block + the surprise quiz** (below) |
| Concept bridge | "What's the equivalent in the other vocabulary?" | **Side-by-side term mapper** with the enforcement difference called out |

### The surprise quiz, from the corpus

Written once per page as structured schema fields, never freeform. Every option gets an
explanation, so a wrong guess still teaches — that matters enormously for a reader whose most
repeated self-description is *"I'm a dinosaur."* **Tone rule, non-negotiable: no question may
make the reader feel behind.** That single constraint repels the exact buyer if violated.

> **Where does an AI translation project actually stall?**
> - A) The AI can't produce a first draft → *"Drafting stopped being the constraint around 2024. Ask anyone running a project now — they have more draft than they can process."*
> - B) **Nobody has capacity to check the draft** ✅ → *"Correct. A coordinator put it exactly: 'There was only so much I could supervise as an individual. So at some point, we needed to interrupt translation because of lack of capacity.' Translation literally stopped — with drafts sitting there."*
> - C) The team resists the tool → *"Less often than expected. A ten-year professional translator's unprompted reaction was relief: 'technology developed to support and elevate the translators, not to substitute.'"*

That is Folashade's cleared line doing Layer-3 work (a citable, specific, non-obvious claim) and
Pillar-2 work ("the bottleneck moved and nobody said so") at the same time.

---

## 4. Architecture — a small extension of what's already built

Data and presentation stay separated, and the rendering path already exists.

```
content/graph/*.json          →   src/prerender/library/*.tsx   →   dist/library/**/*.html
(nodes + edges, validated)        (one renderer per page family)     (static, fully rendered)
                                                                      ↓
                              scripts/build-library.ts extends dist/sitemap.xml
```

- **Reuse the prerender pipeline.** `scripts/prerender-marketing.ts` already bundles React for
  Node, renders with `react-dom/server`, and writes static HTML. The library generator is the
  same path with a loop over graph nodes instead of a fixed manifest. **Do not add a vite entry
  per page** — that doesn't scale past a few dozen; emit HTML directly.
- **Fully rendered HTML, no client-side content injection.** Non-negotiable for indexing
  stability at scale; the pipeline already guarantees it.
- **Deterministic titles.** `"{Language} translation: script, corpora, and what a project hits"`.
  Never AI-generated titles.
- **Schema-first generation.** AI fills validated JSON node schemas. AI never writes a page.
  Validate every node against the schema before it can reach `status: published`.
- **Worker routing is nearly free.** `worker/index.ts` already falls through to `env.ASSETS`
  for unknown paths, so `/library/*` serves as static assets with no route table changes. Add
  the family hubs to `MARKETING_PAGES` in `scripts/prerender-marketing.ts` so they get
  canonicals and JSON-LD.
- **JSON-LD per family.** `DefinedTerm` for concepts, `TechArticle` for formats, `FAQPage` for
  questions, `Dataset` for the language index. Engines lean on this to decide what a page *is*.

---

## 5. The routine — how this iterates

**The graph is the state. The routine is the scheduler. The loss function is the gate.**

### The loss function

A node cannot move `draft → published` until all six pass. This is the anti-slop contract and it
is machine-checkable except for the last line.

1. **≥3 node-specific facts** that appear on no other node.
2. **An interactive component** tied to a one-sentence named outcome.
3. **Answer-first opening ≤40 words** that resolves the page's question before any preamble.
4. **≥1 primary-source citation** with a URL.
5. **Zero quotes outside the cleared allowlist** — the 12 lines in Kit §10, at their stated
   safety grade, with named detail stripped where the grade says 🟡.
6. **The two-question test, written out in the node record.** If a human can't write it, the
   node doesn't publish.

Site-level gates, evaluated by the routine:

- Indexed ratio ≥60% of submitted URLs at 60 days, per family.
- Any family below 1 click per indexed page per month at 90 days → refract or retire it.
- AEO: cited in ≥3 of the 20 panel prompts by day 90.

### The routine itself

Two cadences. Concretely these are scheduled Routines firing a fresh session; they work
identically as a human weekly ritual if you'd rather drive them by hand.

**Weekly — the graph walk.** Fresh session, ~30 min of agent time:
1. Pull GSC + Bing coverage and PostHog `/library/*` stats.
2. Mark every node failing a site-level gate as `refract`.
3. Mine new GSC queries into candidate `question` nodes (`status: draft`).
4. Enrich the highest-value 10–20 draft nodes; run the loss function; publish what passes.
5. Open a PR. **Never auto-merge** — the safety gate on quotes is human.

**Monthly — the visibility re-audit.** Re-run the 20-prompt panel across ChatGPT, Claude,
Perplexity, Gemini, and Google AI Overviews. Record: were we cited, who was cited instead,
which page of ours (if any) was the source. Diff against last month. That diff is the actual
steering signal — it tells you which layer is still binding.

**Refraction schedule** so nothing decays: high-traffic nodes every 30–60 days, mid-tier every
90, new nodes left alone for 60–90 days to index before being touched. Meaningful updates only —
new facts, new corpora, updated status — never a year-bump masquerading as a refresh.

---

## 6. 90-day plan, weakest layer first

### Phase 1, weeks 1–4 — Retrieval (get into the pool at all)

| Action | Effort | Why |
|---|---|---|
| Verify Google Search Console + Bing Webmaster Tools, submit `dist/sitemap.xml` | S | **Blocking everything.** There is currently no coverage data at all, so no feedback loop can exist. Bing matters disproportionately — ChatGPT's retrieval leans on it. |
| Ship the graph schema + validator + `build-library.ts` | M | The substrate |
| Publish **format family first** (20–40 pages) | M | Highest data density, lowest risk, zero quote exposure, and it answers a literal customer question ("can we output back to USFM?"). Fastest honest win. |
| Rewrite homepage + both case studies answer-first, add Pieter's measured line above the fold | S | Currently both case-study pages are pure "after" with no "before" — see Kit §9. Also the highest-leverage Layer-3 edit available. |

### Phase 2, weeks 5–8 — Source Preference (be where the engines look)

The citation set from the live probe is the target list, and none of it is your own site.

| Action | Effort | Why |
|---|---|---|
| Directory + entity footprint: faith.tools, AI-and-Faith, Missio Nexus, Wikidata entry, Crunchbase, G2 | M | Directories are directly in the observed citation set |
| **Publish the "State of Ministry Translation" report** — original data | L | See below. Single highest-leverage asset in this plan. |
| Question family, batch 1 (30 pages) from the corpus | M | Answer-first, citable, explicit claims |
| Genuine participation where the sector actually is — ICCM, Missional AI, Church IT Network; not Reddit brigading | M | Real community presence, not astroturf. The ICP doc's "convene the empty room" play is the same motion. |

**The report is the keystone.** You hold something no competitor has: 17 recorded buyer
conversations and a measured throughput result. An annual report with real numbers —
reviewers per language, project durations, where projects stall — is the artifact that
roundups cite, that LLMs can quote, and that earns unlinked brand mentions. It is also the
purest expression of the credibility-marketing posture: give away the thing a consultancy would
bill for. Anonymised to role, cleared through the Kit §12 gate.

### Phase 3, weeks 9–12 — Selection (be the one it names)

| Action | Effort | Why |
|---|---|---|
| Language family, gated batch 1 (100–200 nodes) | L | Long-tail retrieval breadth |
| One honest comparison page, hand-written | S | Not a family. Written to be *fair*, including where you're not the fit. |
| Concept bridge family (20–30) | M | Claims the unoccupied interpreter position |
| Stand up both routines | S | Iteration becomes automatic |

---

## 7. What not to do

- **Don't chase "AI church translation."** Different product, app-store competitors, wrong buyer.
- **Don't build org/customer landing pages.** Thin, and it implies relationships you can't claim.
  Come and See routes public mention through a marketing department: **treat them as proof, not
  as a prospect, and get sign-off before any post frames them around a pain quote.**
- **Don't let the generator touch the quote corpus.** Only the 12 cleared lines are graph-eligible,
  at their stated grade. A pipeline that pulls quotes automatically will eventually publish a
  burned one, and in this network that's unrecoverable.
- **Don't emit localization beacons** on `register: ministry` nodes. Add it to the validator.
- **Don't publish a page family before its hub.** Orphan pages don't index.
- **Don't ship any page whose only differentiator is a substituted name.** That's the failure mode
  this entire loss function exists to prevent.

---

## 8. KPIs

**Leading (weekly):** indexed ratio by family · new GSC queries surfaced · nodes published /
nodes failing the loss function (a rising failure rate is *healthy* — it means the gate works).

**Core (monthly):** organic visitors (baseline: **6 / 90 days**) · citation rate across the
20-prompt panel by engine · unlinked brand-mention velocity · AI-referred sessions and their
conversion to a booked call.

**Lagging (quarterly):** booked calls attributable to organic or AI-referred · pipeline
influenced · share of the 20-prompt panel where Aquilla is named vs. where the answer is
Aquilla's thesis credited to someone else. **Closing that second gap is the real objective.**

---

## 9. Open questions

1. **GSC/Bing access** — does anyone own these properties yet? Nothing in this plan can iterate
   without coverage data.
2. **Quote clearance** — is anyone chasing written permission beyond the 12 cleared lines? The
   corpus is the strongest asset here and the clearance rate governs how much of it is usable.
3. **Report ownership** — the State of Ministry Translation report needs a named human author
   for EEAT. Who signs it?
4. **Language data licensing** — Ethnologue is not freely redistributable. The language family
   needs to be built on ISO 639-3, eBible, Progress.Bible, and your own parser coverage.
   Confirm before generating.
5. **Publishing cadence tolerance** — how visible can this be before it reads as farming to the
   ICCM crowd? My read is that a `/library` framed as a reference and released steadily is safe,
   and a burst of 500 pages in a week is not.
