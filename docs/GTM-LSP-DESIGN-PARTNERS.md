# GTM — LSP Design Partners: the reality check

Research memo, 2026-08-24. Companion to the LSP market-expansion hypothesis: Aquilla as an
**agentic orchestration layer on top of specialist LSPs' existing stacks** (Phrase / memoQ /
Trados / Smartling for production; Plunet / XTRF for business management), sold through a
three-LSP design-partner cohort ("expert-led automation": experts keep judgment, agents absorb
coordination/research/checking toil).

This memo answers: **when the first three LSPs try the product, what are the top ten objections
that immediately arise, why do they decide it isn't for them, what tempts them most strongly,
and what do they say "100% yes" to?** It is written from *their* world — what keeps an LSP
owner safe, powerful, and high-status — not from our roadmap.

**Method.** Four web-research passes collected verbatim practitioner language from
r/TranslationStudies and r/localization (fetched directly), Capterra/Software Advice/GetApp and
G2-syndicated reviews of Phrase, memoQ, Trados/RWS, Smartling, XTM, Wordbee, Plunet, XTRF,
LSP.expert, RWS Community forums, ATA, ATC/Slator/CSA/Nimdzi coverage, LSP company statements,
and the reception of the closest analogue products (Lilt, Blackbird.io, Intento, Custom.MT,
Bureau Works, memoQ AGT, Phrase AI, Smartling, Unbabel). A parallel pass inventoried what this
repo actually shows a trial user today (Appendix B). Everything inside quotation marks in
Appendix A was read in a live fetch or search snippet during the research session and carries
its source; paraphrases are marked. ProZ and Slator block fetching — ProZ contributes thread
titles only; Slator quotes come via search snippets. The italicized "voice in the room" lines
in §2 are **composites we wrote** to compress the evidence — they are not real quotes; the real
quotes sit under them.

---

## 1. Their world, not ours

The pitch meets four different people, and any one of them can quietly kill the trial:

- **The owner/MD** protects client trust, margin, and the firm's identity. Safety, in their
  vocabulary, is *control*: on-premise deployability, perpetual licences, GDPR jurisdiction,
  exit rights. A buyer chose memoQ because "memoQ may be deployed on premise, contrary to
  cloud-based competitors" — filed under "safety issues." Subscriptions read as the opposite:
  "Forcing users toward recurring SaaS payments turns software from an asset into an ongoing
  liability." Their nightmare is being "vulnerable to losing access to their critical tools."
- **The ops director / senior PM** protects delivery. Their life is the half-automated
  boundary: files that come back from the CAT but don't land in the BMS, "4-5 places where you
  need to update the same thing," QA reports with "loads of false positives," being "a
  glorified file pusher" who is "at the receiving end of both client and vendor complaints."
  They do not want another dashboard; they want the residue between their existing dashboards
  to disappear.
- **The senior linguist/reviser** protects craft, rates, and accountability. Their rate logic
  is liability, not effort: "I edit human translation for 50% — if it's bad, the translator can
  be held accountable. AI can't." Their identity: "We get paid for accountability, not for
  cleaning a mess." They have a proven veto: they nullify imposed platforms ("export to
  bilingual docx, translate with my CAT of choice, import back"), surcharge bad tools, or
  leave — and when they leave, quality collapses first ("the team slashed their rates by 45%
  because 'AI does all the work anyway'... that team is now the least profitable part of the
  company because quality plummeted").
- **The client-facing owner (again)** lives inside a contradiction that defines this moment:
  clients now ban unmanaged AI *and* demand managed AI at the same time. Contract clauses
  arrived within "a single twelve-month window": "The Consultant must not... use Generative AI
  in providing the Services," enforced by "immediate rejection and non-payment." Yet 84% of
  LSPs report clients asking for human editing of AI output, and buyers "are still turning to
  their LSC provider to manage" AI. Managing that contradiction *for* the client is the
  highest-status work available to an LSP right now: "Now I'm talking to the same companies
  about risk, governance, and liability — that's a much more senior conversation."

Two more facts about their world frame everything below. Their commercial engine is still the
word: 87% of LSPs price per word, with TM fuzzy-match discount grids — any tool that ignores
that arithmetic is illegible. And their trust in vendors is forensic, not statistical: the
industry's own bad actors have "started masking MT as 100% matches," so provenance honesty —
what the machine did, what a human verified — is currency, while confidence scores convince
nobody ("I haven't seen a system or AI agent that would actually guarantee that a translation
is correct in the past ten years" — Samuel Läubli, CEO of Supertext, who *sells* AI
translation).

---

## 2. The top ten objections

Ordered roughly by lethality. Each: the composite voice, what's underneath it, the evidence,
and where today's app confirms or defuses it (file anchors in Appendix B).

### 1. "This is a second system, not a layer."

*The voice in the room: "You said you'd work inside our stack. This is a new workspace with a
new login, a new editor, and a new place my PMs have to keep in sync with Phrase and Plunet.
We've been burned by half-integrations before — the last one had people delivering files to two
different applications."*

Underneath: the ops director's deepest trauma is the 90%-automated round trip whose last 10%
lands on humans. A consultant reviewing the Plunet–memoQ integration described exactly this:
"Trying to convince them to consistently deliver files to two different applications is next to
impossible... a real time-robber... a source of human error." Meanwhile linguists have a proven
countermeasure to imposed editors — the bilingual-export escape hatch — and account-poisoning
from below is documented at the analogues ("Smartling is horrible to use and your translators
will keep hating it"; its own buyers call the editor "worst-in-class").

Today's app makes the objection true: the trial experience *is* a standalone workspace. The
Agent API has no webhooks or continuous-localization surface yet, and there are no Phrase/memoQ
connectors — so "we watch a project enter Phrase" is a pitch the product cannot yet perform.
The one adoption grammar that reliably overcomes this class of objection is Blackbird's:
connector-first, TMS-agnostic, measured time-collapse ("automations in a couple of days that
used to take us an entire quarter").

### 2. "It ignores the assets my whole business runs on."

*The voice in the room: "Where's my TM? I uploaded our TMX and it became... text. No fuzzy
matches, no leverage analysis, no pretranslate. My quoting, my discount grid, my client
relationships are built on that arithmetic. And if your agents don't consume our TM and
termbase, what exactly makes their output ours?"*

Underneath: the TM and termbase are the LSP's accumulated capital — the thing that makes them
defensible and the thing their pricing model prices. The only AI approach practitioners endorse
unprompted is grounded in the customer's own data: "Translation automation is at its best when
it is based on the user's existing domain data" (memoQ's founder); the one satisfied AGT user
says it "works well with projects that have a rich TM"; the community's favorite tools are
"adaptive MT... that leverage glossary and TM and adjust to the translator as they work."

Today's app: TMX imports land as cells, not a queryable TM; there are no fuzzy bands, no
match-rate analysis, no TM pretranslate (the global TM index exists but is inert); onboarding
literally shows "Import glossary / translation memory — coming soon." The termbase, by
contrast, is real and good (TBX/CSV, preferred/admitted/forbidden statuses, pre-acceptance
warnings, org-wide sharing) — it is the strongest existing answer to this objection and should
lead the demo, not the editor.

### 3. "Where does our clients' text go?"

*The voice in the room: "Half our MSAs now have generative-AI clauses. One says 'must not use
Generative AI in the creation of any Deliverables' — non-compliance is rejection and
non-payment. Which models see our content? Where is it processed? Who trains on it? Send me
the DPA and the subprocessor list before anyone here uploads a file."*

Underneath: this went from vibe to contract in about twelve months. "The shift from AI as an
operational variable to AI as a contractual risk happened within a single twelve-month
window." Jurisdiction is compliance, not preference: "Paste a confidential clinical report or a
defense bid into a public AI translation tool, and the text lands on servers you don't control,
under a jurisdiction you never picked." Note the nuance: enterprise practice has already
normalized *bring-your-own keys* ("Nearly 9 in 10 enterprise teams require or prefer
bring-your-own API keys"; "56.6% value contractual non-training and data retention terms") — so
Aquilla's BYO-provider-key setup step is actually the *right* architecture that currently
presents as an hour-one trust shock ("give a startup your OpenRouter key before trust
exists").

Today's app: password-only auth (no SSO/SAML), an OpenRouter proxy fan-out, Cloudflare-only
deployment, no signed-DPA/no-training story surfaced anywhere in the product. All answerable —
but it must be answered in the first meeting, not discovered as an absence in the app.

### 4. "You're a markup on someone else's model."

*The voice in the room: "So what am I actually paying for? I bring my own API key, the models
are OpenAI/Anthropic/Google's, and your credits carry a multiple on the provider price. I've
seen this pitch. Phrase and Bureau Works already resell GPT with markup — you're smaller and
newer."*

Underneath: this is the reflex dismissal of the entire product class, and it is the deal-killer
at the analogues: "even advanced folks like Phrase or Bureau Works basically resell GPT 5 (not
the best translator) with markup"; "charges hundreds of dollars for quite limited GPT-5.4
powered functionality, with a premium on tokens"; Lilt "LARP as a tech company"; memoQ's most
influential trainer waving off "useless GenAI marketing fluff." Fused to it is consumption-
pricing distrust — the audience's mental unit is the word, and opaque metering is where vendor
trust goes to die: "the devil is firmly in the details of what counts as a processed word";
"Oooooh that explains the sudden huge monthly bill on my credit card"; a quota model that
punishes quoting ("you are pitching for a large project, well you are blowing your quota with
no return"). Pricing-model *changes* are trust events remembered for years (RWS "abusive"
thread; XTRF's "price increase by more than 100 percent... announced in a poorly written
email").

Today's app: credit rails carry 4–5× markups (the agent rail highest), the usage panel
deliberately shows no pricing, and the Field plan meters "AI words" — word-denominated (good
instinct, closer to their mental model than tokens) but with an invisible multiple (exactly the
shape they distrust). The defusal is structural, not cosmetic: charge for orchestration,
evidence, and outcomes; pass model costs through transparently at cost on their own keys.

### 5. "Who is accountable when it's wrong — and will my best people accept being its cleanup crew?"

*The voice in the room: "If an agent mistranslates a contraindication, who owns that? My
reviser? Your model? Me? My revisers have told me exactly how they feel about cleaning machine
output — I can't hand my best people an MTPE workflow with a new name. They'll quote me the
rates thread."*

Underneath: two fused facts. First, the liability void — "AI can't take responsibility for
errors. They just want us to be the ones who they can blame"; "Patents get revoked because of
words"; "Improvement is not the same as reliability. In legal and IP translation, reliability
is non-negotiable"; "when AI translations cause errors in high-stakes contexts... determining
responsibility is complex." Second, the *sequence insult*: machine-first-human-after is the
hated pattern ("polish a turd," "proofreaders of software-generated content," "spot the
difference"), while assist-during is welcomed ("takes the most tedious parts off my shoulders —
for example consistency with glossaries"; "My kingdom to be part of the process, rather than an
afterthought"). If the pilot routes agent drafts to senior revisers for cleanup, the linguists
will experience MTPE 2.0 regardless of our framing — and they are the veto.

Today's app: provenance is genuinely good bones (`ai_suggestion`, `agent_run_id` carried
through events; staged changesets; human approval gate) — this is the raw material of an
accountability story their clients' auditors could accept. What's missing is the mapping: no
ISO 17100/18587-shaped review stages, no second-translator revision structure, and the
changeset proposer is currently allowed to approve their own changeset — the opposite of the
second-pair-of-eyes rule their compliance narrative requires.

### 6. "Your safety gate is my new toil."

*The voice in the room: "You're proud of the approval gate. Walk me through approving a 40,000-
word job. My reviewer clicks... every cell? On top of the QA false positives we already drown
in? You've automated the drafting and manualized the approving."*

Underneath: QA-noise trauma is universal and tool-independent ("Loads of false positives" —
XTM; "too many false positives" — memoQ; "flag issues that are not actually errors" —
Smartling; same complaint about Xbench regex checks). Reviewers' attention is the scarcest
resource in the whole operation; any gate that spends it linearly is regressive. The gate must
convert into *authority* (rules, sampling, batch scopes, risk-tiering, a kill switch — the
reviewer as the agent's boss) rather than *clicking* (the reviewer as the agent's QA slave).

Today's app confirms the objection in code: untouched AI drafts are excluded from bulk
validation (one-cell-at-a-time by design), and changeset approval is per-changeset with a
15-minute confirmation TTL bound to a browser session. Right instinct (auditable, human-held),
wrong ergonomics at LSP scale.

### 7. "This obviously wasn't built for us."

*The voice in the room: "Your import screen's 'Popular' sources are Bible corpora. The sample
org is 'Acme Bible Translation.' The editor navigates by chapter and verse. Where do I put the
client? The deadline? The job number? If I demo this to my team, I lose credibility."*

Underneath: status. The ops leader who champions a tool wears its smell internally. (It cuts
both ways: for theological/scripture-adjacent and other mission-driven high-trust publishers,
the same surfaces are *credibility* — the wedge choice decides whether this is a bug or the
moat.) The second half is deeper than branding: the atoms of agency life — client, deadline,
quote, job, PO, vendor — do not exist as concepts, and a per-word/leverage quote can't be
constructed. They will forgive a missing feature; they can't forgive evidence the product
doesn't know what business they're in.

Today's app: 7 of 13 import tiles are Bible corpora; eBible and Hello AO sit in "Popular";
chapter navigation is first-class; project creation has no client, deadline, or domain field.
The multi-brand system controls only name/theme/copy — a neutral brand does *not* hide the
Bible surfaces without code changes.

### 8. "What happens to us if you disappear?"

*The voice in the room: "You're a small company pivoting from Bible-translation software, and
you're asking me to put client work through your cloud. Can we self-host? Is the open-source
part real or a slide? If you die or get acquired by someone we don't like, what do we hold?"*

Underneath: exit rights are the safety vocabulary of this buyer — on-prem, perpetual, "true
ownership," jurisdiction. And their organic proxies for vendor survival are support
responsiveness and visible momentum, not certifications ("The customer service is abysmal";
bugs "reported months and years ago are still not fixed"; "not seen any major improvements...
since our subscription 4 years ago" — all named as churn reasons). They will probe response
speed constantly during a pilot; a design partnership with the founder personally embedded is
the strongest possible answer to this — which is why that offer belongs in the pitch.

Today's app: self-hosting does not exist (the backend is Cloudflare-coupled: Workers, Durable
Objects, R2, Hyperdrive→Neon; the pricing-page "self-host" line has no implementation). The
strategy memo's instinct — open core, monetize the operate/integrate layer — is *strongly*
validated by the evidence, but today it is a promise the product can't keep. Do not pitch it
before it is real; this audience remembers pricing/promise breaches for a decade.

### 9. "What do I tell my clients — and who keeps the savings?"

*The voice in the room: "My contract says human-produced. The EU AI Act wants AI-generated
content marked unless a human reviewed it. If I tell clients I've automated, they'll demand
the discount — they already treat MT as a price anchor. If I don't tell them, and it leaks,
I'm the agency that lied. Your tool creates a disclosure question I didn't have yesterday."*

Underneath: clients "know machine translation is nearly free, so any human involvement feels
expensive by comparison"; MT savings historically got clawed back as client discounts; the
ugly workaround (disguising MT as TM matches) is now a documented fraud pattern they're
terrified of resembling. The EU AI Act's marker exemption — AI-generated translated content
must be machine-readably marked "unless the translations have undergone a human review" —
actually makes an expert-verification evidence trail a *compliance asset*. The winning answer
makes disclosure their strategic choice with evidence for either posture: an audit pack that
proves expert review (for the disclose-and-upsell posture) or an internal-efficiency framing
with zero client-visible change (for the keep-the-margin posture).

### 10. "Your pilot costs me my scarcest people before it proves anything."

*The voice in the room: "Month 1 is 'workflow audit + integration.' That's my ops lead and my
best PM, mid-season, teaching a startup our business — while Gartner says 40% of agentic
projects get canceled. We have no baseline numbers for 'human minutes per 1,000 words,' and if
we start measuring, my PMs will read it as surveillance and my margins become visible. Who
does the work, and what does failure cost me?"*

Underneath: recounted AI-pilot failures are organizational, not model-quality ("companies...
let go of their localization teams... quickly found out that these teams were doing a lot more
than translation"; "38% of localization buyers said inefficient AI use is their biggest cost
inefficiency"); onboarding quality is scrutinized as a proof point in reviews; translators
already suspect covert measurement ("I've always wondered if y'all were looking at how much I
change things"). The five-metric loop is right, but the baseline mostly doesn't exist and must
be reconstructed (shadow mode over completed projects), individual-level metrics are a revolt
trigger (measure cohorts and workflows, never people), and the margin numbers are the owner's
most guarded secret (their data, their publication veto — consent for the "4.2→2.1" case study
is a contract clause, not an assumption).

---

## 3. Why they decide it isn't for them

The stated objection is rarely the real reason. Four deeper ones:

1. **The identity trap.** A specialist LSP's self-concept *is* the orchestration layer —
   coordination, vendor management, QA judgment are what the owner believes makes them a
   company rather than a rolodex. "Agents absorb the coordination" can sound like "we automate
   the part that is you." The counter-type exists and is the qualification filter: the owner
   who says, with TransPerfect's CEO, "Cannibalize yourself. If you can bring a better
   solution... even if it's going to mean a decrease in your services revenue, you bring it."
   That is Ryder's "redesign the company" early adopter — the CSA line for them is "shift from
   being cooks to being chefs."
2. **Risk asymmetry.** Upside: margin points. Downside: one quality incident in regulated
   content, an anchor client's trust, or the resignation of the reviser who holds three client
   relationships together. "Improvement is not the same as reliability" is a walk-away
   sentence: until the gate story is airtight, a rational owner declines a good expected value.
3. **The proof costs the scarcest asset.** Senior PM + senior reviser attention is the one
   thing they cannot buy more of — and it's exactly what a Month-1 integration consumes. Pilot
   fatigue with the category ("if you discovered AI in 2023, you are not an expert...
   an opportunist peddling fear and motivational quotes") raises the prior that this spend is
   wasted.
4. **The pitch–product gap.** They were promised a layer over their stack; the trial hands
   them a second workspace with Bible tiles and no TM leverage. Nothing kills design-partner
   trust faster than discovering the pitch describes the roadmap. Sell what exists (a
   service-led engagement powered by the Agent API + their stack's APIs), or close the gap
   first.

Also real, and worth respecting: **timing**. These firms are perpetually mid-migration,
mid-season, mid-client-audit. "Come back in Q3" is often true, not a brush-off — cohort
recruitment should plan for a 3–5× funnel over the three slots.

## 4. What tempts them most strongly

In descending order of pull, mapped to what it gives them:

1. **Closing the half-automated boundary** (peace + effort). The round-trip residue, the
   double entry, the chasing, the status-syncing between BMS and TMS. This is where the only
   uncontested adoption stories in the whole corpus live: "we save a lot of time" (working CAT
   integration), "saved over sixty-two working hours every month" (a connector), "a couple of
   days that used to take us an entire quarter" (Blackbird). Toil has no defenders; nobody's
   identity is invested in re-keying data.
2. **Terminology and consistency enforcement that actually works** (peace + quality bar).
   Named as both the biggest MTPE toil ("term cleanup is the main work in MTPE"; "The main
   issue in MT is inconsistent target terminology. Nobody has really been able to fix this
   problem at scale") and the assist linguists explicitly welcome ("All I need is a
   client-specific termbase and a CAT tool that suggests those terms"). Fewer QA false
   positives is a universal wish. Aquilla's termbase + violations inbox + pre-acceptance
   checks is the strongest thing in the current product for this audience.
3. **Capacity without hiring** (power). Taking the RFP they'd have declined, quoting in an
   hour, overnight preflight, absorbing a volume spike without burning the bench, serving
   long-tail/low-resource language pairs competitors can't staff. Growth without fixed cost is
   the owner's dream state — and it frames agents as *more* business for the same experts,
   which is the only frame the supply side will tolerate.
4. **The senior conversation** (status). Governance evidence — provenance, expert sign-off
   trails, ISO-shaped process — upgrades the owner from vendor to advisor: "risk, governance,
   and liability — that's a much more senior conversation." Being demonstrably
   "AI-forward but expert-led" wins RFPs against both the AI-deniers and the MTPE mills, and
   the design-partner story itself is conference-stage material for them.
5. **Private observability of their own operation** (power). They have never actually seen
   their process — minutes per 1,000 words, where PM hours go, which clients' work bleeds
   margin. The measurement they fear publicly they crave privately. Sold as "your private
   mirror, your data, your publication veto," it converts from threat to temptation.
6. **Margin they don't have to hand back** (peace). MT-era savings became client discounts;
   agent-era savings on *coordination* are invisible to the client's price anchor and can be
   kept. "You keep 100% of the savings; what you pass through is your strategic choice" is the
   commercial sentence they haven't heard from this category.
7. **The founder in their Slack** (all three). "I will personally work with the first three"
   buys them a senior AI team for a fraction of a hire, and their operations shaping the
   product roadmap is a status good, not just a discount. This offer is validated — lead with
   it.

## 5. What they say "100% yes" to

The mirror image of the objections — the promises that close clean, in roughly the order they
need to be said:

1. **"Your linguists keep their tools. Nothing changes in their editor on day one."** Agents
   work the seams — prep, terminology, references, consistency pre-checks, QA triage, query
   drafting, status round-trips — and hand experts better inputs, in-flight, not machine
   output to clean up after the fact.
2. **"We never become the system of record. Turn us off Tuesday, deliver Wednesday."** The
   TMS keeps custody of TMs, termbases, and files; Aquilla holds process, evidence, and
   orchestration state only. No-custody is the single sentence that moves us from the
   "exposed" to the "safe" side of their ledger.
3. **"Your keys, your models, your data — contractually."** No training on their content,
   named subprocessors, EU processing where required, DPA and NDA signed before the first
   file, BYO provider keys at cost. (Their world already prefers BYO keys; make the trust
   architecture explicit instead of discovered.)
4. **"Shadow mode first: we replay finished projects you own and show you the delta."**
   Zero production risk, no client exposure, no linguist disruption — and it manufactures the
   baseline that doesn't exist. (Scope it to content they have rights to reuse; some MSAs
   restrict even internal reprocessing.)
5. **"Every agent action is logged: what the machine did, what a human verified, who signed
   off."** An evidence pack mapped to ISO 17100/18587 language and the EU AI Act's
   human-review exemption — their compliance shield, generated as a by-product of the work.
6. **"Your senior reviewer is the agent's boss, not its cleanup crew."** Authority ergonomics:
   rules and thresholds they set, batch and sampling approvals, risk-tiered gates, a kill
   switch — never cell-by-cell clicking. And the proposer can never approve their own change.
7. **"Linguist rates don't change during the pilot, and nothing measures individuals."**
   Cohort- and workflow-level metrics only. This single clause disarms the revolt trigger and
   the surveillance trigger at once.
8. **"Fixed-fee pilot, defined exit, you keep everything."** The data, the measurement
   report, the configured workflows — theirs either way. No per-seat, no quota that punishes
   quoting, any pricing change with long written notice. (Pricing integrity is a trust event
   in this market; say so in the contract, not the FAQ.)
9. **"You keep 100% of the savings. What you tell clients is your call — we arm either
   answer."** Internal-efficiency framing with zero client-visible change, or
   disclose-and-upsell with the evidence pack. Their choice, their leverage.
10. **"We do the integration lift; your people's time is capped and scheduled."** Named
    hours from their side, the founder personally embedded, support-response SLA from day
    one — because in their experience, support responsiveness *is* vendor viability.

## 6. Consequences for the pitch and the pilot

- **Sell the toil removed, not the technology.** The category words ("agentic AI") now
  pattern-match to hype this audience has already discounted ("What exists today is best
  described as advanced workflow automation" — from a *vendor*; Gartner's 40%-canceled
  prediction circulates). The LinkedIn draft's qualification and "not replacing your
  translators, and not replacing your TMS" line speak the validated dialect — keep them. Add
  the two reassurances the evidence says decide it: data terms, and "your linguists keep
  their tools." Drop "agentic layer" from the cold pitch in favor of the named toil list;
  reintroduce the architecture word once they're in the room.
- **Recruit for the "cannibalize yourself" owner.** The memo's instinct is right and now has
  a test: does the owner talk about AI as redesign ("cooks to chefs") or as a cheaper MT
  engine? Only the former survives objections §3.1–3.3.
- **Wedge choice sharpens the domain-smell objection.** Theological/mission publishers and
  low-resource-language work: current surfaces are credibility. Legal/medical/regulated:
  they're a liability until a neutral brand *and* de-Bibled defaults exist. Pick the first
  cohort accordingly or budget the work.
- **Minimum credible product for a non-theological cohort** (each item maps to an objection):
  SDLXLIFF/Trados-package intake and tag-safe round-trip export (§2.1, §2.7 — today inline
  tags export as plain text, which is disqualifying for production files); TM leverage
  (§2.2 — even read-only match analysis changes the conversation); webhook/connector surface
  for at least one TMS (§2.1); SSO + DPA + subprocessor list (§2.3); batch/rules approval
  ergonomics + no self-approval (§2.5, §2.6); client/deadline/job atoms or an explicit
  BMS-linking story (§2.7); a real self-host or escrow-grade exit answer *before* it is
  pitched (§2.8).
- **Run the measurement as theirs.** Shadow-mode baselines on completed projects; cohort-level
  metrics only; margin data under their lock; case-study publication as an explicit contract
  clause. The five numbers in the strategy memo are the right five — reviewer-corrections must
  be defined with *their* quality bar (LQA rubric they sign off), or the number will be
  contested the first time it's inconvenient.
- **Price the engagement like a covenant, not a meter.** Fixed implementation fee +
  flat platform fee + model costs passed through at cost on their keys. Any credit-style
  multiple on inference will eventually be discovered and read as the "markup on someone
  else's model" objection made flesh (§2.4).

---

## Appendix A — Quote bank

Everything quoted was read in a live fetch or search snippet on 2026-08-24; sources inline.
Snippet-sourced items are marked [snippet]; paraphrases [paraphrase]. Reddit quotes are from
public threads fetched via old.reddit.com; speaker described by role where evident. Five
flagship quotes were independently re-verified against raw fetched page data or a second
source (marked ✓).

### The supply side (translators/revisers) — r/TranslationStudies unless noted

- ✓ "They've just offered me 30% of the base rate for MTPE. For reference, I take 50% for
  editing human translation. I refused. We (some of us) have been digging our own grave for
  quite some time now." — game-loc/literary translator, ex-PM
  (reddit.com/r/TranslationStudies/comments/1qp5l33/)
- ✓ "I edit human translation for 50% - if it's bad, the translator can be held accountable.
  AI can't." / "the AI can't take responsibility for errors. They just want us to be the ones
  who they can blame and charge if this goes wrong." — same thread
- "at some point we all stopped being translators and became proofreaders of
  software-generated content. And I liked translating." (comments/1v4i8ng/)
- "It's like putting blots of paint on a canvas and asking an artist to fix it, expecting the
  result to be the Mona Lisa. They want machines, they get machine output." (comments/1qp5l33/)
- "when I was in-house they made us use MTPE and said not to translate from scratch but rather
  polish a turd." (comments/1eyk1uv/)
- "There's not that much saving in time since you are still held accountable for the MT's
  mistakes so it's basically a pay cut with more work attached to it." (comments/1tsylww/)
- "With MTPE, I have to compare two texts and play a game of spot the difference."
  (comments/1eyk1uv/)
- "ISO 17100 makes that second reviewer mandatory. It works because someone is accountable for
  every line, not because the model runs unsupervised." / "buyers aren't paying for speed,
  they're paying for compliance. We get paid for accountability, not for cleaning a mess."
  (comments/1uj4z31/)
- "All I need is a client-specific termbase and a CAT tool that suggests those terms when they
  appear in the source. Anything beyond that, well… I want AI to do my laundry and keep my
  house clean, not to do all the fun/satisfying parts of my job for me." (comments/1uj4z31/)
- "[the tool] takes the most tedious parts off my shoulders - for example consistency with
  glossaries and previous translations... It also detects my changes and immediately applies
  them to any related string... This client pays per worked hour. This really makes the
  difference and it can be a path that makes sense for everyone involved." —
  subtitler/localizer, same thread
- "The main issue in MT is inconsistent target terminology. Nobody has really been able to fix
  this problem at scale... So term cleanup is the main work in MTPE." (comments/1k0vk7f/)
- "My kingdom to be part of the process, rather than an afterthought." (comments/1o4x0f1/)
- PM voice: "The real burden for me as a PM are TMS with stupid UX or missing/lacking features
  (like clear reporting or an orderly way to deal with, track and resolve translator comments)
  yet no one is using AI to solve those. Smdh. They should be improving the tool, not the
  thing the tool creates." (comments/1uj4z31/)
- Escape hatch: "For long jobs, I always export to bilingual docx, translate with my CAT of
  choice, import back into Phrase, run QA check and finish." (comments/1epqsxc/)
- "I used to charge more if I had to work in XTM." (comments/1h32kpi/) / on XTM: "No
  flexibility at all for translators... Why does anyone think they need to re-invent the wheel
  instead of going with Trados or MemoQ shortcuts?" / "It's bad for translators, but who cares
  about them."
- Surveillance: PM: "we can see how often translators accept those suggestions without change,
  and it varies from hyper-vigilant to almost reckless." Translator, in reply: "Ha I've always
  wondered if y'all were looking at how much I change things." (comments/1eyk1uv/)
- Data distrust: "could they possibly be using these transcripts as language data for AI?...
  I know other translators might be willing to do that but I don't." (comments/1fzteoc/)
- Match fraud: "An agency started to present low quality GenAI output as 99 % matches" —
  "It was directly confirmed... to be AI output. This was indeed intentional." / "If this is a
  thing, it's fraud. Those are not 99 % matches." (comments/1h3236g/); also "started masking
  MT as 100% matches. I'm speechless and sad how low the industry has sunk." (comments/1upjl4f/)
- Rate-cut aftermath: "the team slashed their rates by 45% because 'AI does all the work
  anyway.' I'm happy to say that team is now the least profitable part of the company because
  quality plummeted and customers are refusing to pay for garbage." (comments/1qp5l33/)
- Agency-side confession: "We sold human translation but delivered MTPE; sold human translation
  + review and delivered MTPE; sold MTPE but delivered MT + AI Post editing... Our margin goal
  was 68% and we reached it most of the time through these scams." — ex-agency staff
  (comments/1m7um88/)
- Stakes: "what I (rev) got was so bad, it would have killed people... 'clear' and 'DANGER'
  had both saying clear." — reviser, heavy engineering (comments/1m7um88/)
- Category fatigue: "if you discovered AI in 2023, you are not an expert... at worst, an
  opportunist peddling fear and motivational quotes" / "'AI-enhanced' means 'you work twice as
  fast for half the pay'" / "The danger isn't that LLMs will replace us tomorrow. It's that
  they'll be used to justify devaluing us today." (comments/1kubd5y/)
- ATA statement: "only a trained professional with deep linguistic and subject matter expertise
  can ensure accuracy and preserve intended meaning"
  (atanet.org/advocacy-outreach/ata-statement-on-artificial-intelligence/)

### Buyers on tools (Capterra / Software Advice / GetApp / G2-via-AWS / RWS Community)

- On-prem as safety: "The option to have on-premise deployment of memoQ server was the main
  reason we chose it" (softwareadvice.co.uk/reviews/475222/memoQ); switching reason: "safety
  issues (memoQ may be deployed on premise, contrary to cloud-based competitors)." — Product
  R&D Director (capterra.com/p/162762/memoQ/reviews/)
- Client dictates tools: "SDL Trados Studio is widely required by translation agencies." /
  "I did not choose Trados over MemoQ, I bought both." / "different programs for different
  clients." (capterra.com/p/151746/Trados-Studio/reviews/)
- Perpetual-licence identity: "A perpetual license provides essential operational security,
  cost predictability, and true ownership of our primary working tools." / "Forcing users
  toward recurring SaaS payments turns software from an asset into an ongoing liability." /
  "leaving linguists vulnerable to losing access to their critical tools and workflows" (RWS
  Community, Trados 2024/2026 pricing threads)
- Pricing trust events: "Upgrade from Studio 2022 FL+ to Studio 2024 FL+ : 556 CAD !!! Are you
  mad, at RWS? Do you think translators are millionaires?" (RWS Community "pricing is abusive"
  thread); XTRF: "Prohibitively expensive, price increase by more than 100 percent in 2023" /
  "announced in a poorly written email, with scant actual hard and fast details" — CEO/founder
  reviewers (Capterra XTRF); Phrase quota: "you are pitching for a large project, well you are
  blowing your quota with no return." — owner (capterra.com/p/276186/Phrase/reviews/)
- Integration residue: "Despite being designated as 'delivered' in memoQ, files didn't get
  returned from memoQ to Plunet for further workflow steps... Trying to convince them to
  consistently deliver files to two different applications is next to impossible... a real
  time-robber... a source of human error." — consultant Richard Sikes on pre-7.0
  Plunet–memoQ (plunet.com, vendor-hosted); [snippet] "if you update something in one place…
  there are another 4-5 places where you need to update the same thing" (G2 XTM-XTRF reviews)
- Connector delight (mirror image): "Thanks to the working CAT integration with Memsource, we
  save a lot of time." — Head of Business Operations (Capterra XTRF); "By integrating our CAT
  tool of choice into XTRF we have saved over sixty-two working hours every month." —
  Avantpage (featuredcustomers.com/vendor/xtrf, vendor-curated)
- Support as churn: "The customer service is abysmal… no way to call them" (Capterra UK,
  Trados); "Smartling's technical support is entirely unhelpful" / "The translation editor is
  worst-in-class" — Head of Localization (capterra.com/p/151866/Smartling/reviews); "Some bugs
  reported months and years ago are still not fixed, heavily affecting our day to day
  business" (XTM, AWS/G2)
- PM life: "being a localization project manager is tough... You are regarded as a glorified
  file pusher... at the receiving end of both client and vendor complaints." / "You feel like
  you have no control over your delivery because you don't speak all 96 languages" / "linguists
  become the punching bag for project managers" (localization.blog/2021/04/06/)
- QA noise, cross-tool: "Loads of false positives." (XTM); "QA desires improvement (too many
  false positives)" (memoQ); "automated quality checks can be repetitive or flag issues that
  are not actually errors" (Smartling); "I am getting too many false positives and missing
  issues." (Xbench-style regex, RWS Community)

### Execs & clients on AI (2023–2026)

- ✓ "I haven't seen a system or AI agent that would actually guarantee that a translation is
  correct in the past ten years" — Samuel Läubli, CEO, Supertext, SlatorCon Remote 2025
  (slator.com/the-top-25-language-industry-quotes-in-2025/ [snippet])
- "companies in Silicon Valley... let go of their localization teams because they thought 'Gen
  AI can just replace them.' They quickly found out that these teams were doing a lot more
  than translation." / "language professionals have to shift from being cooks to being
  chefs." — Arle Lommel, CSA Research (rubric.com/en-us/ai-v-lsps/)
- "38% of localization buyers said inefficient AI use is their biggest cost inefficiency." —
  Florian Faes, Slator (phrase.com/blog/posts/slatorcon-2025-localization-ai-trends/)
- Contract clauses: "The Consultant must not, and must ensure its Personnel do not, use
  Generative AI in providing the Services or in the creation or modification of any
  Deliverables." (lawinsider.com/clause/generative-ai); "unauthorized AI usage triggers
  immediate rejection of the deliverable. This is not discretionary." / "The shift from AI as
  an operational variable to AI as a contractual risk happened within a single twelve-month
  window." (1stopasia.com/blog/ai-regulation-for-language-vendors-2026/)
- Jurisdiction: "Paste a confidential clinical report or a defense bid into a public AI
  translation tool, and the text lands on servers you don't control, under a jurisdiction you
  never picked." (adverbum.com)
- BYO norms: "Nearly 9 in 10 enterprise teams require or prefer bring-your-own API keys." /
  "56.6% value contractual non-training and data retention terms." / "20.4% of respondents
  reported more quality incidents since introducing AI translation."
  (crowdin.com/blog/ai-translation-enterprise-survey-2026)
- Demand side: "84% of respondents reported that clients had specifically asked for human
  editing services to improve AI translation outputs" [snippet]
  (slator.com/slator-2025-language-industry-market-report/)
- Regulated liability: "Patents get revoked because of words." / "Improvement is not the same
  as reliability. In legal and IP translation, reliability is non-negotiable." — Tim
  Moorcroft, BIG Language (biglanguage.com); EU AI Act: AI-translated content needs
  machine-readable markers "unless the translations have undergone a human review
  (post-editing) before publication." (simultrans.com)
- Pricing shift: "Per-word pricing made sense when translation was mostly human labor." /
  "Clients no longer pay mainly for words… they pay for judgment and accountability." /
  "Now I'm talking to the same companies about risk, governance, and liability—that's a much
  more senior conversation." — Vistatec essay + CRO Caroline O'Connell (vistatec.com; last
  quote possibly paraphrased); "87% of language service providers still use the per-word
  model" [snippet] (straker.ai)
- Owner mindset filter: "Cannibalize yourself. If you can bring a better solution by bringing
  a technology solution to them, even if it's going to mean a decrease in your services
  revenue, you bring it." — Phil Shawe, CEO, TransPerfect (forbes.com, 2025-06-23)
- Vendor honesty: "What exists today is best described as advanced workflow automation." /
  buyers ask "Where is my data stored? How is quality measured? What happens when the system
  makes a mistake?" — Translated (translated.com/resources/ai-agents-translation-real-vs-hype)
- Category risk: "over 40% of agentic AI projects will be canceled by end of 2027" — Gartner
  press release, 2025-06-25

### Analogue-product reception

- ✓ Wrapper dismissal: "But I've been searching around for the past three years, and it
  appears that even advanced folks like Phrase or Bureau Works basically resell GPT 5 (not
  the best translator) with markup, and do like 10% of what the papers did 3 years ago." /
  "Bureau Work [sic] charges hundreds of dollars for quite limited GPT-5.4 powered
  functionality, with a premium on tokens."
  (reddit.com/r/TranslationStudies/comments/1uvavnv/ — both re-verified against the raw
  fetched thread HTML)
- Lilt: "they try so hard to LARP as a tech company" (comments/1lcrqmb/); "I never trusted
  their 'system', I quoted higher to compensate for not being convinced of their 'system'."
  (comments/1ud5zrl/); adoption side: "The interface is clean, easy to use, and doesn't get
  in the way of my workflow." (Capterra)
- Blackbird (vendor-hosted testimonials, labeled as such): "We're building automations in a
  couple of days that used to take us an entire quarter." (Atlassian); "An easy and robust way
  to connect our TMS/BMS to a huge number of different systems, with basically no coding and
  minimum setup effort." (MEINRAD, an LSP) (blackbird.io/testimonials-and-quotes)
- Hub skepticism: "Enterprise tooling rarely consolidates that cleanly. More likely: whoever
  builds the best integrations becomes the de facto hub without being the official one."
  (reddit.com/r/localization/comments/1rrlyrz/)
- memoQ AGT: launch met with indifference ("Anyone tried this already? Any thoughts?" — near
  zero replies, comments/1cw90mz/); power-user: "tune out the company's messaging, which is
  all too driven by trendy irrelevancies and useless GenAI marketing fluff... I for one don't
  need half-assed, buggy new features, just stable, reliable performance" — Kevin Lossner
  (memoquickies.substack.com); founder's grounding claim: "Translation automation is at its
  best when it is based on the user's existing domain data" — Gábor Ugray (memoq.com); user:
  "It works well with projects that have a rich TM, but can be buggy sometimes."
  (comments/1poc83k/)
- Phrase: "Their prices have tripled I believe" / "Oooooh that explains the sudden huge
  monthly bill on my credit card." (comments/1e0krsy/); buyer: "Phrase is a nightmare - it's a
  suite of badly integrated products and everything is a paid add-on." (r/localization
  comments/1sweqty/)
- Smartling: "Do note that prolonged usage of their CAT tool may lead you to reconsider
  living." (comments/1qc725x/); "Smartling is horrible to use and your translators will keep
  hating it." (comments/1sweqty/)
- Consumption-pricing distrust: "the devil is firmly in the details of what counts as a
  processed word." (Lokalise pricing thread, comments/1srj8uo/)
- Orchestration gap named by a practitioner: "Translation memory and terminology databases are
  rigid but mostly reliable. LLMs are flexible but inconsistent. So companies end up in this
  weird middle ground... Marrying those two systems is harder than expected imo" / "better
  orchestration of multilingual content is another direction which is needed more and more"
  (r/localization comments/1rrlyrz/)
- Custom.MT founder on the psychology: "no one wants to have their medication description
  translated by a machine without any human review." — Konstantin Dranch (blog.pangeanic.com)

**Research nulls (honesty about gaps):** no keystroke-surveillance quotes surfaced (ProZ, the
likeliest venue, blocks fetching); no organic buyer reviews mention ISO 17100/27001 or security
questionnaires (that language lives at the client-contract layer, not the tool-review layer);
no independent negative reviews of Blackbird findable; no practitioner reactions to Phrase
QPS/Orchestrator or Trados Copilot findable; no public E&O/indemnity discussion for AI
translation errors.

---

## Appendix B — What a trial LSP hits in the current app (repo inventory, 2026-08-24)

Facts a design-partner trial exposes, with anchors. (Full inventory in the research session.)

- **Import**: XLIFF 1.2/2.0, TMX, DOCX, PPTX, IDML, EPUB, HTML/MD/TXT, PO, properties,
  JSON-i18n, subtitles, spreadsheets exist (`src/lib/parsers/`). **No SDLXLIFF/SDLPPX/TTX**
  (Trados packages — `PARITY_FINAL_REPORT.md:66` lists them out of scope). PDF import exists
  only for the rules knowledge base (`auth-worker/src/routes/parse-document.ts`, 2 MB cap).
- **TM**: TMX imports become project cells (`src/lib/import.ts:571-574`), not queryable TM.
  No fuzzy bands, no leverage analysis, no pretranslate; `GlobalTmIndex` is inert
  (`src/lib/global-tm/index.ts:5-6`); onboarding shows "Import glossary / translation
  memory — coming soon" (`src/lib/i18n/namespaces/onboarding.ts:299`).
- **Termbase (strong)**: TBX-Basic/Min + CSV/TSV import/export, preferred/admitted/forbidden
  statuses, pre-acceptance advisory checks, org-wide sharing with priorities, edit-role floor
  (`src/lib/terminology/`, `auth-worker/src/routes/termbase-subscriptions.ts`).
- **Tag fidelity gap**: edited targets with inline tags export as plain text with a warning;
  >512 KB DOCX/PPTX can't round-trip (`PARITY_FINAL_REPORT.md:60-68`).
- **Bible surfaces in hour one**: 7 of 13 import tiles are Bible corpora, eBible + Hello AO
  under "Popular" (`src/components/ImportDialog.tsx:894-926`); "Acme Bible Translation" org
  placeholder (`onboarding.ts:121`); chapter/verse navigation first-class
  (`src/components/EditorTable.tsx:802-806`). Brand system controls only name/theme/copy —
  these surfaces are not brand-gated (`src/branding/types.ts:41-74`).
- **Auth**: password only; no SSO/SAML/OIDC (`auth-worker/src/routes/auth.ts`). Role ladder
  viewer→owner exists with per-member lane/file scopes (`src/lib/frontier/roles.ts`,
  `auth-worker/src/routes/member-scopes.ts`).
- **Review model**: binary `validated` flag; no translate→edit→proofread stages; untouched AI
  drafts are excluded from bulk validation — reviewed one cell at a time
  (`src/lib/review/review-eligibility.ts`). Changeset approval is per-changeset, 15-minute
  confirmation TTL, browser-session-only — and the proposer is not excluded from approving
  their own changeset (`auth-worker/src/routes/changeset-approvals.ts:14-39`).
- **Agent surface**: external REST + MCP with staged changesets, search, capped staging
  imports (`sync-worker/src/external/`, `docs/AGENT-API.md`); provenance (`ai_suggestion`,
  `agent_run_id`) flows through events. **No webhooks/continuous localization, no export
  command, partial rate limiting** (`docs/AGENT-API.md:34-37`).
- **Ops atoms**: project creation has no client, deadline, quote/job, or domain fields
  (`src/components/ProjectCreateDialog.tsx`); assignments exist as work allocation
  (`auth-worker/src/services/assignments.ts`); comments/presence/focus-locks exist; QA checks
  exist but are not surfaced in the editor (`PARITY_FINAL_REPORT.md:56`).
- **Deployment**: Cloudflare-coupled (Workers, Durable Objects, R2, Hyperdrive→Neon). No
  self-host implementation; the pricing-page "self-host" line has nothing behind it
  (`docs/pricing/pricing-page-draft.html:829`). Tauri desktop shell still talks to hosted
  workers.
- **Commercial**: Field plan $500/4 weeks incl. 100k AI words (`src/lib/billing/plans.ts`);
  credit rails carry 4–5× markups, agent rail highest (`src/lib/credits.ts:29-38`); usage UI
  intentionally shows no pricing (`src/components/settings/UsageSection.tsx:4`). BYO
  AI-provider key is a required onboarding step (`auth-worker/src/routes/chat.ts`).
