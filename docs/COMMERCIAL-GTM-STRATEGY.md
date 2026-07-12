# Aquilla — Commercial Translation Go-to-Market Strategy

**How commercial revenue sustains the mission — the verification layer play**

_Author: strategy synthesis, 2026-07-12. The commercial complement to
[GTM-DISTRIBUTION-PLAN.md](./GTM-DISTRIBUTION-PLAN.md), which owns the mission-side
(Bible-translation) motion. This document is about one thing: how Aquilla earns
commercial revenue that funds the mission without becoming a second company._

---

## 0. TL;DR / The one bet

Aquilla is not a machine-translation company and not a per-word language-services
company. It is **verified-translation-workflow infrastructure** — the provenance-and-
verification layer for translation that has to be trusted. That is the whole bet, and
it is the reason commercial work sustains the mission instead of competing with it:
the commercial product and the mission product are the _same_ product, with the _same_
differentiators — native back-translation, cell-level verification, oversight for
managers who don't read the target language, and an immutable event log.

We make **three coordinated moves**, not one:

1. **Primary (sales-led, high-ACV):** life-sciences linguistic validation and
   regulated labeling — where back-translation and provenance are legally mandatory.
2. **Self-serve (PLG, Postiz-shaped):** Voice Studio for dubbing and dialogue
   localization — the audio stack is already built, the market is growing ~9%/yr.
3. **Connective wedge (ships first):** a verification and ingestion API + MCP server,
   so Aquilla becomes supply _inside_ other people's agent and localization pipelines.

We monetize hosting, oversight seats, usage/API, white-label permission, and
workflow-redesign services — **never per-word**. One codebase, separated from the
mission by license, entity, and fund accounting. A pharma customer who must be legally
right paying for Aquilla is a stronger trust proof than any donor narrative.

---

## 1. What business Aquilla is actually in

The founder's transcript asks the right question: _what business are we in?_ The
answer is neither of the two obvious ones. We are not in machine translation — DeepL
(~$185M revenue, ~$2B valuation, reportedly eyeing a ~$5B IPO) and ElevenLabs
($180M raise, $3B valuation) already own the "output a draft" layer, and they stop
there. We are not in per-word human services — that market is deflating, and pricing
against it would be pricing against ourselves.

Aquilla is in the business of **recording, and making auditable, who verified what**.
Everything the codebase already does points at this. Every write is an immutable event
with a parent chain, an author, and a timestamp — an audit trail is a _byproduct_ of
the architecture, not a feature we bolted on. `cell_validators`, the role taxonomy, the
validation queue, and the "validated" bar are a durable record of who attested to each
unit of translation. `cell_backtranslations` makes back-translation a first-class
artifact. Managers who don't read the target language consume health, validation, and
progress signals rather than the text itself. None of this is retrofittable onto a
string-and-key TMS; it is the shape of the data model.

That is why the commercial beachhead reuses ~100% of the mission architecture. The
same four differentiators that make Aquilla the right tool for a mother-tongue Bible
translation team under consultant oversight make it the right tool for a pharma sponsor
who must prove, to a regulator, that a patient-reported-outcome instrument was
independently forward-translated, reconciled, back-translated, reviewed, and debriefed.
Commercial demand validates the mission's own quality claims. It does not distract from
them because there is nothing separate to build.

**One-line positioning:** _Aquilla is the system of record for who verified what in
translation — AI drafts, humans verify, and every attestation survives audit._

---

## 2. The Postiz lens

The founder asked to run this through the Postiz playbook, and it fits cleanly. Postiz
is an AGPL-3.0 social scheduler that beat Buffer, Hootsuite, and Sprout Social not by
out-featuring them but by serving the self-host / privacy / developer / API niche the
incumbents ignored. It reached ~30K GitHub stars, hit #1 on Product Hunt (May 2026),
and grew to **~$1.3M ARR (~$113K MRR) in about two years, effectively solo**. Three
lessons transfer directly.

**The niche is structural, not demographic.** Postiz's opening was that incumbents
were architecturally bloated for a user who wanted something small and controllable.
Aquilla's equivalent niche is not "translation" broadly — it is **"translation you can
be held liable for."** The CAT-lineage incumbents (RWS/Trados, memoQ, Phrase,
Smartling, Lokalise, XTM, Crowdin) are string/key-oriented — built around i18n resource
files — and they are now bolting agents onto non-auditable cores. The engines stop at
the draft. Nobody is provenance-native. That is the same kind of structural gap Postiz
exploited against Buffer, and it is exactly where willingness-to-pay is _rising_ while
the rest of the industry deflates.

**The 10x move was repositioning to "agentic," not adding features.** Postiz's MRR
jumped from ~$21K to ~$70K in roughly two months — not from feature parity, but from
repositioning from "scheduling" to "agentic" and riding an AI agent's coattails
(OpenClaw). Aquilla's product thesis _already is_ agentic workflow redesign, not another
MT engine. The move is to ship the agent surface (§4.3, §7) so Aquilla becomes supply
inside other people's agent pipelines. This mirrors the mission plan's "coexist before
you replace" wedge (Scripture Forge earned adoption by making Paratext the auth
provider, not by competing): plug in as the trust layer rather than ripping the
existing pipeline out.

**The license is the monetization fence.** Postiz gives the full product away to
self-hosters; commercial network, white-label, and redistribution use must pay or open
their changes. n8n uses a fair-code Sustainable-Use License to the same end; Documenso
sells a $250 "Platform" escape hatch. The open-core operators (Cal.com, Supabase,
PostHog, Dub, Twenty) converge on giving away the full self-hosted product and charging
for (1) hosting convenience, (2) team/collaboration seats, (3) usage above a generous
free allowance, and (4) white-label/embed permission — while keeping the API and agent
surface _cheap and on entry tiers_ (Postiz ships API + MCP on the $29 plan) so
programmatic users get embedded and become sticky. Aquilla's fence keeps the mission
free-and-open under grant funding while commercial redistributors and enterprises
convert — one codebase, separated by license, not a fork.

---

## 3. The market & the white space

The headline number is misleading. Language services were ~$71.7B (2024) → ~$75.7B
(2025), but the CAGR was revised _down_ to ~5% precisely because AI is compressing
per-word revenue. The human-services core has flat-to-declining unit economics. **Do
not compete there.** The slice that is growing is the software layer: the TMS market is
~$2.4–2.6B (2025–26), growing ~8–17%, high-margin. That is where to play.

The incumbents are weak, and it shows in the accounts. RWS (Trados) posted FY25 revenue
of £690M with **adjusted PBT down 43%** and a 6% headcount cut — a legacy CAT-lineage
incumbent re-platforming under duress. The rest of the field (memoQ, Phrase, Smartling,
Lokalise, XTM, Crowdin) is string/key-oriented and not provenance-first or multimodal.
The engines — DeepL, ElevenLabs — output a draft and stop: no verification, no audit,
no oversight layer.

The agentic-localization wave is real but shallow. Lilt rebranded around "agentic AI"
(+$45M Series D, Sequoia); Smartcat raised +$43M (Series C); Lokalise ships "AI agents."
But these bolt agents onto string-based, non-auditable cores. Follow the M&A and the
capital: it flows to engines, and to incumbents _buying_ AI IP (RWS bought Papercup's
dubbing; TransPerfect acquired Unbabel) — **not** to provenance- or verification-native
platforms. That is the white space, and it is unclaimed.

The unclaimed position is a sentence nobody in this market can say honestly: **oversight
for managers who don't read the language, backed by an immutable, cell-level provenance
log of who verified what.** Everyone says "human-in-the-loop." Nobody is _architected_
around verification as the deliverable. Aquilla is.

---

## 4. The beachhead: three coordinated moves

We land, expand, and distribute through three moves that share one codebase and one
data model. They are sequenced so the cheapest, highest-leverage move ships first and
feeds the other two.

| | **1. Life-sciences validation** (Primary) | **2. Voice Studio** (Self-serve) | **3. Verification/Ingestion API + MCP** (Wedge) |
|---|---|---|---|
| Motion | Enterprise sales-led | Product-led (PLG) | Developer-led distribution |
| ACV | 5–6 figures / program | Hundreds–low-thousands / mo | Metered per call; embeds |
| Why now | ISPOR/Part-11/MDR make our differentiators _mandatory_; incumbents must retrofit | Dubbing market ~$13.9B→~$17.4B; engines have no verification layer | MCP SDK ~97M downloads/mo; agents need a place to put human sign-off |
| Native fit | Back-translation + event log + non-reader oversight | Diarization, voice clone, TTS, take model already built | Event-sourced infra on Workers/DO makes this cheap |
| Anchor proof | Biblica pays for custom + support today | Come and See localized _The Chosen_ S1 into 125 languages | Come and See accepts per-project pricing |
| Ships | After the wedge; design-partner pilot | Per `voice-studio-market-spec.md` phases | **First** |

### 4.1 Primary — life-sciences linguistic validation & regulated labeling

This is the strongest fit in the entire market, and the reason is that our
differentiators are not advantages here — they are _requirements_.

Linguistic validation of clinical outcome assessments (COAs) and patient-reported
outcomes (PROs) under **ISPOR is a formal 9–10 step process**: two independent forward
translations → reconciliation → **back-translation** → back-translation review →
harmonization → **cognitive debriefing with patients** → certification dossier, run
_per language, per instrument_, and often across **20+ languages simultaneously**. The
FDA acknowledges the ISPOR framework. **21 CFR Part 11** requires an audit trail of who
changed what, when, and why. **EU MDR/IVDR** require device IFUs and labeling in the
national languages of 27 member states (24 official languages).

Now map that to the product. Back-translation is a native artifact
(`cell_backtranslations`), not a manual re-key. The Part-11 audit trail is our event
log as a byproduct — every write is already immutable and attributed. The sponsor/CRO
oversight of a program run in languages the reviewers can't read is our manager view.
For every incumbent — RWS Life Sciences, Lionbridge, IQVIA, ICON, Signant,
TransPerfect — those three things are retrofits onto a string-based core. For Aquilla
they are the data model.

The economics reward this. These vendors publish no rates (opaque, high margin). General
translation runs ~$0.07–0.18/word, but linguistic validation commands a large multiple,
and a validation program is a **five-to-six-figure project on its own**. WTP rises here
exactly as it deflates elsewhere.

**Entry motion:** land via a design-partner CRO, eCOA vendor, or pharma-localization
contact through the existing network. Scope a single-instrument, multi-language pilot
whose output _is_ the ISPOR back-translation artifact plus the Part-11 audit dossier —
produced as a byproduct of running the workflow, not as extra work. This is
enterprise-sales-shaped, and the founder already accepts that distribution here _is_
enterprise sales. The payoff compounds: a clinical case study directly upgrades the
mission's credibility, because it proves the same quality claims to a regulator.

### 4.2 Self-serve — Voice Studio for dubbing & dialogue localization

This is the Postiz-shaped motion: creator/studio-led, 5-minute onboarding, self-serve.
The audio stack is already built — speaker diarization (pyannote), voice cloning
(seed_vc), multi-provider TTS (Gemini, on-device Kokoro, MMS), Whisper transcription, a
cell-keyed take model, and waveform/peaks. The `voice-studio-market-spec` already
positions this as tier-2 "picks-and-shovels" dubbing/ADR tooling against VoiceQ,
Mosaic, and Cappella.

The market is the fastest-growing segment we touch: dubbing & subtitling ~$13.9B (2025)
→ ~$17.4B (2033); dubbing & voice-over ~$4.55B → ~$11.2B by 2035 (~8.5%); media
localization ~$5.6B → ~$12.8B (~9.4%). Roughly 45% of streamed content is now
foreign-language, and hybrid AI-human workflows cut cost 40–60%. The AI-dubbing vendors
(ElevenLabs Dubbing v2, HeyGen's 175 languages, Deepdub) are engine-first — none
couples generation to a verification/provenance layer or to a back-translated script.
Aquilla targets the quality/liability tier: studios, faith/NGO media, corporate and
e-learning. The 125-language localization of _The Chosen_ Season 1 by Come and See —
one expert plus Aquilla, a twice-set Guinness World Record — is a proof point sitting
directly in this segment.

**Entry motion:** follow the phased plan already in `voice-studio-market-spec.md`.
This move funds itself and feeds the content flywheel shared with the mission plan.

### 4.3 Connective wedge — the Verification & Ingestion API + MCP server

This is the single highest-leverage, lowest-cost move, and it **ships first**. The
pitch is one line: _"Bring your own agent; Aquilla is where the human sign-off and the
audit trail live."_ Ship an MCP server plus an agent-facing ingestion/verification API,
and Aquilla becomes supply inside existing CAT, LLM, and agent pipelines rather than a
rip-and-replace.

Why now, and why cheap: the MCP SDK sees ~97M downloads/month and every major assistant
speaks it; an MCP server puts Aquilla into every agent host's workflow, meterable per
call (x402 / Stripe MPP), and listable on the new MCP directory layer (PulseMCP, Glama,
Smithery) where free listings rank. Aquilla already runs on Cloudflare Workers + Neon
Postgres + R2 + Durable Objects — we own the agent infrastructure needed to ship this
cheaply. This is the OpenClaw-coattails lesson applied: agent-sourced demand, not
feature parity, is what moved Postiz's revenue.

---

## 5. What we decline, and why

The test is one question: **does it force a different architecture, a different
compliance posture, or a different sales motion?** If yes, it is an expensive detour
dressed as a feature extension. On that test we decline:

- **Tier-1 fully-autonomous AI dubbing.** ElevenLabs and HeyGen win it. We use TTS as
  scratch/assist inside a human-verified workflow, not as the product.
- **A full DAW.** Export to Pro Tools. Building a mixing environment is a different
  architecture and a different buyer.
- **Tier-3 managed-service labor.** Sell tools, not headcount. Selling labor changes
  the business model and caps the margin.
- **General per-word commodity translation.** The market is deflating and pricing
  there cannibalizes an agent-first tool that _reduces_ words touched (see §6).
- **For now: legal/certified, eDiscovery, and financial-disclosure translation.** The
  provenance pattern is identical — a named human must attest, and the attestation must
  survive audit — which is why these are the natural expansion. But each needs its own
  compliance posture and sales motion, so they are expansion-only, after a repeatable
  clinical case study exists. (For reference on adjacent size: legal certified/sworn/
  notarized fees stack $30/$50/$90 per document on top of per-word; patents run
  $0.10–0.18/word with dual review; the eDiscovery market is ~$12.9B.)

Declining these is not caution; it is what keeps the three moves in §4 sharing one
codebase.

---

## 6. The commercial model

Open-core is the frame. The full product is free to self-host and free-for-the-field /
mission (grants fund that), behind an **AGPL or fair-code (Sustainable-Use) fence**.
Commercial network use, white-label, and embedded/redistribution use pay or open their
changes. This is the mechanism that lets grants keep funding the mission while
commercial redistributors and enterprises convert — separated by license, not by a
fork.

On top of the open core we monetize four buckets plus services.

| Bucket | What the customer pays for | Basis | Validated by |
|---|---|---|---|
| **1. Hosted convenience** | Managed cloud — someone else runs the infra | Platform fee offsetting inference/infra | Biblica already pays a platform fee to offset inference |
| **2. Oversight seats** | Manager, validator, reviewer seats — the people who attest and oversee | Per-verifier seat (**not per-word**) | The manager/oversight view is the anchor feature |
| **3. Usage / API** | Verified-unit throughput, agent surface, MCP calls, per-project scope | Per-verified-unit or per-call metering; per-project fees | Come and See accepts per-project pricing |
| **4. White-label / commercial-use permission** | The right to embed, resell, or run commercial-network use | License fee (the AGPL/fair-code escape hatch) | Documenso $250 Platform; n8n resale license |
| **+ Services** | Workflow-redesign engagements and dedicated support | Fixed-fee / retainer | Biblica already pays for custom + ongoing support |

**Why NOT per-word.** The market is shifting away from per-seat toward usage/volume +
platform fee + services — Lokalise dropped per-seat pricing and lists ~$144–$999/mo
billed on words processed; Phrase self-serve is ~$525/mo with a business floor of
~$15k/yr; Smartling runs 2–3× Lokalise. Enterprise ACV lands low-five to low-six
figures; mid-market $600–$12k/yr. But Aquilla's whole thesis is that agents _reduce_
words touched. Pricing per-word would mean charging less exactly as we deliver more
value — self-cannibalization. So we price the platform, the oversight seats, the
verified units and API calls, and the redesign services. The unit we meter is the one
we increase (verified attestations), not the one we shrink (words).

---

## 7. Agent-first distribution

The distribution strategy is the wedge from §4.3, widened. An MCP server is not a
feature; it is a channel. It makes Aquilla **supply inside other people's agents** —
free distribution across every agent host, meterable per call, discoverable on the MCP
directory layer (PulseMCP, Glama, Smithery) where free listings rank the way app-store
listings once did. This is the "reposition to agentic and ride the coattails" move that
10x'd Postiz, applied as our primary cheap channel.

Around it, the standard open-core niche marketing, run at near-zero CAC (content +
community time):

- **Repo-as-billboard** and concentrated launch weeks (Show HN, r/selfhosted — ~100K
  views is normal for a launch there — Product Hunt).
- **Comparison SEO** against the bloated incumbents: "Aquilla vs Trados for linguistic
  validation," "back-translation workflow," "Part-11 audit trail for translation."
- **Seed integrations** into adjacent marketplaces: MCP directories, n8n templates,
  the CAT interop path (Aquilla already parses _and_ exports XLIFF, TMX, PO,
  CSV/TSV-bilingual, DOCX, PPTX, JSON-i18n, spreadsheet, SRT/SBV/VTT, markdown,
  plaintext, and properties, round-trip tested — so it can sit inside existing
  localization pipelines from day one).

Two things the regulated side additionally requires, which pure open-core does not:
**standards conformance stated publicly** (XLIFF/TMX interop, and a Part-11 / ISPOR
posture) and **one anchor reference customer**, plus vertical thought leadership via the
founder's LinkedIn writing. The **content flywheel is shared with the mission plan** —
the same autopilot engine that turns meeting transcripts into published proof feeds
both stories; this document does not rebuild it, it points at it.

---

## 8. The mission ↔ commercial firewall

The founder's identity worry — that commercial work corrupts or distracts the mission —
is answered by _how_ the two are separated. Separation is by **license + entity + fund
accounting, not by a product fork.** One codebase.

- **Mission side:** grants fund access, onboarding, white-glove support, and
  free-for-the-field distribution via the open core.
- **Commercial side:** regulated verticals plus hosted/white-label revenue, ideally
  housed in a commercial entity (a PBC or subsidiary) that _licenses_ the open core and
  returns surplus to the mission.

The two never diverge into different software, so there is no second product to
maintain, no second roadmap to reconcile, and no risk that commercial pressure quietly
degrades the mission's tool — because it _is_ the mission's tool.

The deeper point is that payment provides the objective value signal the nonprofit
otherwise lacks. A pharma customer who must be legally right, paying real money for
Aquilla because the back-translation and the Part-11 audit trail hold up, is a stronger
trust proof than any donor narrative. And it becomes leverage: commercial evidence is
what lets Aquilla later approach Wycliffe/SIL from a position of proof rather than
persuasion — the same "prove outcomes before forcing adoption" logic the mission plan
uses with consultants and Scripture Forge. Anything that fails the §5 test — a different
architecture, compliance posture, or sales motion — is declined precisely to protect
this firewall.

---

## 9. Metrics & the value signal

**Payment is the headline signal.** A customer who pays because they must be legally
right is the objective proof the mission has always lacked. Everything else is a
leading indicator of that.

The single metric to surface publicly is the **AI-reliance vs validated-human ratio** —
already a product concept. It is the one number a regulator, a sponsor, _and_ a
consultant all want: how much of this translation is machine draft versus attested human
verification. It is legible to every buyer in every one of the three moves, and it is
the numeric form of the entire positioning. Supporting metrics:

- **Verified units** — throughput of attested translation (the thing we meter and grow).
- **Audit-trail completeness** — the proportion of the workflow captured as immutable,
  attributed events (the Part-11 proof, measured).
- **Per-project margin** — proof the model funds itself without per-word pricing.
- **Design-partner references** — named, on-record customers per vertical; the currency
  that converts the next enterprise deal and the next mission conversation.

---

## 10. 90-day plan

Sequenced so the cheapest, highest-leverage move (the agent API/MCP) lands first and
the sales-cycle-heavy move (life sciences) starts early because it takes longest.

**Days 0–30 — ship the wedge, open the pipeline**
- [ ] Ship the **verification & ingestion API + MCP server** on the existing
      Workers/DO infra; meter per call; list on PulseMCP, Glama, Smithery.
- [ ] Choose the **open-core license** (AGPL vs fair-code Sustainable-Use) and apply it
      to the repo — the monetization fence has to exist before the hosted tier.
- [ ] Warm-intro **3–5 life-sciences design-partner targets** (CRO, eCOA vendor,
      pharma-loc contact) through the existing network.
- [ ] Publish the **standards/compliance posture** page (XLIFF/TMX interop, Part-11 /
      ISPOR framing).

**Days 30–60 — stand up the model, launch PLG**
- [ ] Ship the **hosted tier + pricing page** for the four buckets + services (platform
      fee, oversight seats, usage/API, white-label permission).
- [ ] Scope and sign a **single-instrument, multi-language life-sciences pilot** whose
      output is the ISPOR back-translation artifact + Part-11 audit dossier.
- [ ] **Launch Voice Studio PLG** per the phases in `voice-studio-market-spec.md` —
      5-minute onboarding, self-serve, leaning on the 125-language proof.

**Days 60–90 — prove it and pour fuel**
- [ ] Deliver the pilot; capture the **first regulated case study** (the AI-reliance vs
      validated-human ratio and audit-trail completeness front and center).
- [ ] Publish **comparison SEO** against the incumbents (Aquilla vs Trados for
      validation; back-translation/Part-11 workflow pages).
- [ ] Review the metrics in §9; decide where to concentrate.

---

## 11. Risks & honest failure modes

| Risk | Why it's real | Mitigation |
|---|---|---|
| **Commercial distraction** | Enterprise sales could pull focus and headcount off the mission | Separation by license/entity/fund accounting, _not_ a fork; one codebase means commercial work _is_ mission work. Decline anything failing the §5 architecture/compliance/sales-motion test |
| **Regulated sales-cycle length** | Life-sciences deals are 5–6 figures but slow; opaque, gatekept procurement | Ship the low-cost API/MCP wedge and self-serve Voice Studio _first_ so revenue and reference logos accrue while the clinical pilot matures; land one design partner, don't chase many |
| **Per-word cannibalization temptation** | The market defaults to per-word/volume pricing; sales will be pulled toward it | Hard rule: never price per-word. Meter verified units, seats, API calls, platform fee, services — the units we _grow_, not the ones we shrink |
| **Open-core give-away fear** | "If it's free to self-host, who pays?" | The Postiz/n8n/Documenso evidence: hosting convenience, seats, usage, and white-label _permission_ convert; keep the API cheap and on entry tiers to embed users. ~$1.3M ARR solo is the proof the fence holds |
| **Compliance / validation liability** | We are selling into Part-11 / ISPOR / MDR contexts where being wrong has legal weight | Position as the _system of record_ for human attestation, not the attester; the named human signs off, Aquilla records it immutably. Conformance stated publicly and verifiably, not as a sales claim |
| **Voice-consent / ethics** | Voice cloning (seed_vc) invites misuse and consent disputes | Consent provenance in the same event log; target the quality/liability tier (studios, faith/NGO, corporate) that _wants_ auditable consent, not the anything-goes creator market ElevenLabs/HeyGen serve |
| **Incumbent response** | RWS/Lilt/Smartcat could bolt on a provenance layer once they see the wedge | Their string-based cores make provenance a retrofit, not a rewrite; the event-sourced data model is the moat. Move first, bank the reference customers, and let their -43% PBT and re-platforming buy the time |

The honest summary: the biggest risk is not a competitor and not the market — it is
internal, the temptation to treat commercial as a second company. The §8 firewall exists
precisely because the failure mode is organizational, not technical. Keep one codebase,
price the units we grow, decline the detours, and commercial revenue funds the mission by
being the same work — done for people who have no choice but to pay for it to be right.
