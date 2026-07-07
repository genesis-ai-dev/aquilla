# Distribution Orchestration — the Broadcast Pipeline

_The concrete design for the **Broadcast** half of the agent company (the equal-weight twin of the Build pipeline in `AGENT-ORCHESTRATION-STRATEGY.md`). How autonomous agents produce, schedule, and optimize distribution for **Aquilla** — announcement/docs video, posting cadence, listings & launches, and constant pSEO/GEO — without tripping spam enforcement or burning brand trust._

> Grounded in a research sweep (delegated to fan-out agents, per the L3 principle). Sources at the bottom. Two facts shape every decision here:
> 1. **Aquilla's audience is niche** (Bible-translation orgs, linguists, academic/translation NGOs, plus technical early adopters). For niche products, **research and qualification of channels matters far more than submission volume** — spraying 200 directories is actively harmful.
> 2. **Aquilla owns rare structured data** (terminology entries, language pairs, interlinear alignments, rules, back-translations). Original data is the single strongest driver of both pSEO value and LLM citations — this is the product's distribution superpower, not the social cadence.

---

## 1. Architecture — the same shape as Build

Reuse the proven pattern from `swarm-orchestration`: **fan out cheap agents to gather, funnel all outward-facing actions through a single coherent thread with a human gate.** Distribution is *write-to-the-world* work, so the discipline is even stricter than code.

```
   PostHog + Search Console + AI-citation monitors  (the demand signal)
                              │
                              ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  Broadcast Conductor (Opus, single, durable state)            │
   │  owns: calendar, voice/taste, the publish gate, attribution   │
   └───────────────┬───────────────────────────────┬─────────────┘
        Scouts (Haiku, cheap, parallel)     Content workers (Sonnet, worktrees)
        - channel research & qualification   - release notes / blog / docs pages
        - keyword & intent mining            - pSEO page generation from product data
        - competitor & citation monitoring   - video scripts + Remotion compositions
        - draft directory listings           - social post drafts per channel
                              │
                              ▼
        Evaluators  →  HUMAN GATE (taste + brand + anything irreversible)  →  Publish
                              │
                              ▼
            Postiz (schedule) · directory submitters · git deploy (site/docs)
                              │
                              ▼
                    Measure → feed back into demand signal
```

- **New Linear project: `Distribution`** (sibling to `Prototype Debugging`), with the same status lifecycle and `Dispatched`-as-lock convention so one agent owns a task at a time.
- **Durable state**: `docs/distribution/CALENDAR.md` (what ships when), `CHANNELS.md` (the living, qualified target list), `TRACES.md` (open experiments, what's been submitted where), mirroring `docs/swarm/`.
- **The publish gate is the analog of the STOP checklist**: nothing goes outward-facing without passing it (see §6).

---

## 2. The asset factory — video & written content

### Video: prefer **deterministic** generation; reserve **generative** for hero moments

This is the most important architectural call. An autonomous loop needs video it can produce reliably on a cadence — that means **code/template-driven** for the 90% case, with AI generation only for occasional launch hero shots.

| Layer | Tool | Why it fits an autonomous loop |
|---|---|---|
| **Deterministic announcement & docs video (DEFAULT)** | **HyperFrames** (HeyGen's open-source HTML/CSS→MP4 renderer) **or Remotion** (React-based) | Video is *code*. An agent writes HTML/CSS animations (HyperFrames) or a React composition (Remotion) from changelog/release JSON; a headless Chromium + FFmpeg render produces a deterministic, on-brand MP4 every time. No hallucinated visuals, fully reviewable as a diff. **HyperFrames is the notable 2026 entrant**: Apache-2.0, `npx skills add heygen-com/hyperframes` installs it directly as a Claude Code agent skill, and the HTML/CSS paradigm is more natural for LLM code-gen than React. Pick HyperFrames if starting fresh; Remotion if the team already lives in React (it has more mature Lambda/CI render paths). ~$0.10–0.20 compute per 2-min video. **This is the workhorse.** |
| **Voiceover** | **ElevenLabs API** | Script (from the same release data) → narration audio track piped into HyperFrames/Remotion. Deterministic, scriptable, consistent voice, ~$0.01/video. |
| **Talking-head announcements** | **HeyGen** (avatar, API) | Optional "founder update" clips from a script. Use sparingly — authenticity matters for this audience. |
| **Interactive product demos** | **Arcade / Supademo / Storylane** | Auto-captured clickable walkthroughs of the real app — higher-converting than video for a tool, and they double as embeddable docs (~40% higher engagement). **Caveat: no headless APIs** — these are human-capture tools, so they're a human-assisted asset, not part of the autonomous render loop. |
| **Generative b-roll / hero (EXCEPTION)** | **fal.ai → Veo 3.1 / Runway Gen-4.5 / Pika** | Only for launch-moment hero footage where a unique visual matters. fal.ai is the pragmatic single-gateway choice (hedges model availability). Human-gated; 10–100x the cost; never the routine path. |

**Rule:** changelog data → HyperFrames (or Remotion) + ElevenLabs → reviewable MP4 is the cadence path — fully deterministic, retryable, diff-reviewable. **Generative video (Veo/Runway/Pika) is opt-in, human-approved, launch-only**, because it's non-reproducible, slow, content-moderated, and far costlier — unsafe to leave inside an autonomous loop.

### Written content (Sonnet workers, one Opus editor for voice)
Release notes (from merged `FRO-###` + git), blog posts (deeper dives, original data stories from the corpus), docs pages, and comparison pages (`Aquilla vs Paratext/FLEx/Logos` — captures high-intent "alternative to" search). All drafted cheap, **all passed through one Opus editor enforcing a single brand voice** — fragmenting voice across agents is the marketing version of Cognition's "inconsistent bird" failure.

---

## 3. Scheduling & cadence — Postiz as the backbone

**Postiz** (github.com/gitroomhq/postiz-app) is the right scheduling spine for an agent pipeline: open-source, self-hostable, and explicitly built for agentic use.

- **Deploy**: Docker Compose (Next.js + NestJS + Postgres + Redis). Self-host gives a configurable `API_LIMIT` (default 90 req/hr) and a free, full-featured instance.
- **License caveat (important):** **AGPL-3.0** — if we build a SaaS *on top of* a modified Postiz, that derivative must be open-sourced (or we get a commercial license). For internal use as our own scheduler this is fine; flag it before any productization.
- **Agent surfaces**: REST API (`POST /posts` schedule/now, `GET /integrations`, `POST /upload`), an official **Node SDK**, a dedicated **`postiz-agent` CLI** (installable as a Claude skill via `npx skills add gitroomhq/postiz-agent`), and a **native MCP server** — so the Conductor can schedule directly.
- **Channels (31+)**: X, LinkedIn, Instagram, Facebook, Threads, TikTok, YouTube, Reddit, Bluesky, Mastodon, Discord, Slack, Telegram, plus blogging targets (WordPress, Medium, Hashnode, **Dev.to**).

**The autonomy reality is gated by the *platforms*, not Postiz** — tier channels by how freely an agent can post:

| Tier | Channels | Autonomy |
|---|---|---|
| **Green — post freely** | Bluesky, Mastodon, Threads, Discord, Telegram, **Reddit (mechanically)**, WordPress/Dev.to/Hashnode | No dev-approval gauntlet, lenient limits. Agent can schedule autonomously. |
| **Yellow — works at low volume + budget** | X/Twitter | Free tier ~500 posts/mo at ~$0.01/post; media upload caps. Fine for a measured cadence. |
| **Red — human/business-gated** | LinkedIn, TikTok, Instagram | LinkedIn Partner Program (weeks–months, enterprise pricing); TikTok/Meta app audits. Public posting is gated behind approvals; don't design the loop to depend on these initially. |

**Critical nuance — "can post" ≠ "should auto-post."** Reddit is *mechanically* green but *reputationally red*: automated promotional posts get communities to flag you, and this audience's communities (r/linguistics, SIL forums) are small and unforgiving. **Reddit, HN, and niche-community posts are human-authored, always** (see §6).

**Sane starting cadence** (adjust from data; quality over volume for a niche):
- **Owned, daily-ish**: changelog/build-in-public notes to Bluesky/Mastodon/X (Green/Yellow), auto-scheduled.
- **Weekly**: one substantive blog/docs piece (an original-data story or how-to), syndicated to Dev.to/Hashnode/Medium + cross-posted social.
- **Per release**: Remotion announcement video + release notes + interactive demo.
- **Monthly**: one deeper original-research artifact (the GEO/citation magnet — see §4).
- **Event-driven, human-led**: Product Hunt / Show HN / conference & community announcements (FBAI, BT Conference, SBL, ACL).

_Alternatives if we want vendor-managed instead of self-host:_ **Ayrshare** (most API-friendly SaaS, ~$149+/mo), Buffer API (simple), Mixpost (self-host but weaker API). Postiz remains the strongest open pick for agents.

---

## 4. The pSEO + GEO engine — the compounding core

This is where Aquilla's data moat pays off, and where the biggest *and* riskiest automation lives.

### pSEO done right (genuine value, not doorway spam)
Generate programmatic pages **from the real product corpus**, where each page has standalone value:
- **Terminology / concept pages** (a term, its renderings across languages, alignment examples) — genuinely useful reference content drawn from live data.
- **Language / language-pair pages** (what Aquilla supports, with real interlinear examples).
- **Comparison pages** (`Aquilla vs Paratext / FLEx / Logos`) — high-intent capture.
- **How-to / workflow pages** tied to real features.

Each template gets: unique data-driven body, internal links into the link graph, `schema.org` structured data, fresh `lastmod`, and an indexation policy. **The product's `homepage.html` already templates OG/Twitter/canonical meta and ships pre-hydration crawlable content** — extend that pattern to programmatic pages.

**What gets pSEO penalized (the guardrail list):** thin/near-duplicate pages, mass pages with no unique data, unnatural internal-link patterns, generating thousands of pages overnight. Google's helpful-content/spam updates specifically target this.

### GEO/AEO — get cited by ChatGPT/Claude/Perplexity/AI Overviews
The new, increasingly dominant layer. Evidence is strong and consistent:
- **~80% of AI-cited URLs don't rank in Google's top 100** — GEO is a *distinct* discipline from SEO.
- **Only 5–10% of AI citations come from a brand's own site** (McKinsey) → **off-site presence dominates**: third-party media coverage gives a ~5x citation likelihood; presence on **G2/Capterra** gives a ~3x multiplier; **Reddit (~40% of LLM training citations) and Wikipedia (~26%)** are foundational sources.
- **Original research + statistics + expert quotes** drive citations (Princeton GEO study: expert quotes ~+41%, stats ~+30%). Aquilla can publish **original data reports** (alignment coverage across languages, terminology consistency benchmarks) — exactly the citation-magnet content LLMs prefer.
- **On-site GEO tactics** (safe to automate): self-contained 40–60 word answer chunks, FAQ + structured data, an **`llms.txt`**, definitional clarity, freshness (AI citations drop sharply for content >3 months old → automate refresh of stale pages).

### What the agent automates vs. what stays human
- **Automate (safe, on a loop):** keyword/intent research, template population from product data, internal-link graph maintenance, metadata + schema, `llms.txt`, **stale-content refresh**, broken-link & Core-Web-Vitals monitoring, Search Console ingestion.
- **Human-gate:** launching a *net-new page type* at scale, brand voice, and any original-research framing/claims.

**Biggest risk of unsupervised pSEO:** a single bad data row populates thousands of near-duplicate pages at once, tripping Google's (now Gemini-powered, continuous) scaled-content detection → **sitewide** demotion that wipes organic traffic before a human can intervene and takes months to recover. Post-May-2026, demotion is domain-wide, not page-level — sites where programmatic content exceeded ~70% of inventory saw -78% clicks within 72h.

**The one guardrail that prevents it — a mandatory pre-publish quality gate** between template population and publish, which the Conductor cannot bypass:
- **Dedup check:** flag if >20% semantic similarity across the batch.
- **Minimum value:** ≥500 unique words, ≥30% differentiated content, and ≥1 data field unique to that page (does this page contain something found nowhere else?).
- **Rate cap:** no batch larger than ~2–4x human-plausible daily output; staged rollout (100-page pilot → watch 2–4 weeks → scale only if indexation stays >80%).
- **Human sign-off** for any *new template class* and any batch over a set size (e.g., >500 pages). The agent proposes; the human approves the first run of a page type; subsequent runs auto-execute while quality metrics stay in bounds.

**Entity anchoring (quick, high-leverage):** create a **Wikidata** entry now (no notability threshold) and point `Organization` `sameAs` at it — Wikidata underpins Google's Knowledge Graph and becomes the permanent entity anchor LLMs disambiguate against. Pursue a Wikipedia article only once 3–5 independent reliable sources exist (the JOSS/SBL/press credibility plays in §5 feed exactly this).

---

## 5. Listings & launches — qualify, don't spray

### General SaaS channels (the automate/human split is sharp)
| Channel | Value | Automate? |
|---|---|---|
| **AlternativeTo, SaaSHub, SourceForge, BetaList** | Compounding backlinks + comparison traffic | ✅ Agent drafts + submits (unique copy each) |
| **G2 / Capterra** (now one company since Feb 2026) | **AI-citation multiplier + buyer intent**; free tier worth it | ⚠️ Agent maintains profile; **reviews need real customers** (FTC fake-review rule — incentives must be sentiment-neutral and disclosed; **never fake or auto-generate reviews**) |
| **Product Hunt** | High short-term spike | ❌ **Human-led** — hunter relationships, 24h live comment engagement, vote-manipulation detection |
| **Hacker News (Show HN)** | High authority if it lands | ❌ **Human-only** — coordinated voting/AI-generated comments = instant ban |

### Niche channels (where this audience actually is — research > volume)
Maintain a **living, qualified `CHANNELS.md`**, not a blast list. High-value targets the scouts found:
- **Bible-translation tech:** SIL Language Software Community, **Paratext / support.bible** (~15k users / 2,400 languages), Wycliffe, Faith Comes By Hearing (GitHub), YouVersion Platform, **FBAI** (annual meeting), **BT Conference**, **faith.tools** directory (400+ apps).
- **Academic linguistics / DH:** **LINGUIST List** (~26k subscribers), **SBL** (~8.3k scholars), **OLAC**, **JOSS** (peer-reviewed software credibility), Zenodo, university DH library guides, **ACL/EMNLP/AmericasNLP** (indigenous-language NLP).
- **Translation/localization:** ATA, GALA, Machine Translate newsletter, Crowdin/Tolgee communities.
- **Technical:** Dev.to/Hashnode (tags: #nlp #linguistics #opensource), relevant subreddits, GitHub.

For this audience, **credibility (JOSS peer review, SBL/conference presence, accurate Wikipedia/Wikidata) outperforms hype.** That credibility is also what makes you citable by LLMs (§4) — the two goals reinforce.

### The submission loop (every listing/outreach item)
`research → qualify (DR/relevance/audience-fit) → draft unique copy → HUMAN APPROVE → submit → verify indexed → track`. **Anti-spam discipline:** ≤5–10 submissions/week (never bulk), DR-40+ targets only, 3–4 unique description variants minimum, monthly indexing checks. Bulk identical submissions trip Google's unnatural-velocity detection and waste reputation.

---

## 6. Autonomy & the human gate (risk-tiered)

The whole pipeline runs on **blast-radius tiering** — the same principle as Build, stricter outward-facing:

| Tier | Actions | Policy |
|---|---|---|
| **0–1 — Autonomous** | Research, keyword/competitor/citation monitoring, drafting, pSEO template population, metadata/schema/`llms.txt`, stale-page refresh, scheduling Green-tier social, low-risk directory submissions | Agent executes; logged to `TRACES.md` |
| **2 — Human-approve before publish** | Net-new blog/page-type, video publish, comparison pages, G2/Capterra profile changes, any X/Yellow-tier posting at volume | Conductor drafts → human one-click approve |
| **3 — Human-led (agent assists only)** | **Product Hunt, Show HN, Reddit & niche-community posts, conference/community outreach, email outreach, anything claiming original-research findings, paid spend** | Human authors/owns; agent prepares assets only |

**Non-negotiables:** community posts are never autonomous (spam enforcement + irreversible reputation damage in small communities); reviews are never fabricated (FTC, ~$53k/violation); the brand voice always passes one human/Opus taste check. Per the agent-pipeline research, *"agents handle execution, humans retain approval authority"* for all external communications — and 88% of autonomous-agent pilots fail on governance/observability, not model quality, so the gates and logging are the product.

---

## 7. Skills & infra to build

Keep skills thin and few (the API surface between Conductor and workers):
- **`/distribute`** — Broadcast entry point: read `Distribution` Linear queue → fan out scouts/workers → assemble → gate → schedule.
- **`/ship`** — release ritual: changelog → release notes → Remotion video + VO → docs update → schedule social → make "shipped & announced" the terminal state (closes the L3 "real artists ship" loop).
- **`/seo`** — the pSEO/GEO loop: ingest Search Console + AI-citation data → refresh stale pages → propose new data-driven pages (gated) → maintain `llms.txt`/schema.
- **`/listings`** — the qualify→draft→approve→submit→track loop against `CHANNELS.md`.

Infra: the **shared scheduler/cron** (same one that runs Build's L1 loop); **Postiz** self-hosted + MCP wired to the Conductor; **analytics ingestion** (Search Console API, PostHog, an AI-citation monitor for "share of model"); circuit breakers + per-run budget caps; durable state in `docs/distribution/`.

---

## 8. Measurement — the feedback loop

Track and feed back weekly: Search Console impressions/clicks/positions; **AI-citation share ("share of model")** across ChatGPT/Claude/Perplexity/AI Overviews; referral traffic by channel (AI referrals convert far higher than generic search); directory-listing traffic; social engagement; and PostHog activation from each source. The Conductor uses this to reallocate effort — kill what doesn't compound, double down on what does. **The roadmap is demand-pulled, not repo-pushed.**

---

## 9. Phased rollout

1. **Phase 1 (now):** stand up `Distribution` Linear project + `docs/distribution/` state. Ship `/ship` (Remotion + release notes) and start the Green-tier build-in-public cadence. Highest leverage, lowest risk.
2. **Phase 2:** self-host Postiz + wire its MCP; `/distribute` drives the weekly content + social calendar through the human gate.
3. **Phase 3:** `/seo` — pSEO from product data (capped, gated) + GEO/`llms.txt` + Search Console feedback. The compounding engine.
4. **Phase 4:** `/listings` against a qualified `CHANNELS.md`; seed G2/Capterra + JOSS/credibility plays; human-led PH/HN/community launches with agent-prepared assets.
5. **Phase 5:** monthly original-data research artifacts (the citation magnet) + share-of-model tracking closing the loop.

---

## Sources

**Scheduling:** [Postiz (GitHub)](https://github.com/gitroomhq/postiz-app) · [Postiz API docs](https://docs.postiz.com/public-api/introduction) · [postiz-agent CLI](https://github.com/gitroomhq/postiz-agent) · platform rate limits ([Postproxy](https://postproxy.dev/blog/social-media-platform-api-rules-rate-limits-media-specs/)) · [Ayrshare](https://www.ayrshare.com/) · [Mixpost](https://github.com/inovector/mixpost)

**Video:** [Remotion](https://github.com/remotion-dev/remotion) · [ElevenLabs](https://elevenlabs.io/) · [HeyGen](https://www.heygen.com/) · [Arcade](https://www.arcade.software/) / [Supademo](https://supademo.com/) · [Runway](https://runwayml.com/) / [Google Veo](https://deepmind.google/models/veo/)

**pSEO / GEO:** [Semrush — AI search optimization](https://www.semrush.com/blog/ai-search-optimization/) · [State of GEO Q1 2026 (Superlines)](https://www.superlines.io/articles/the-state-of-geo-in-q1-2026/) · [Princeton GEO study](https://arxiv.org/abs/2311.09735) · [How LLMs source brand info — 23k citations (Omniscient)](https://beomniscient.com/blog/how-llms-source-brand-information/) · [Review platforms in AI Overviews (SE Ranking)](https://seranking.com/blog/review-platforms-in-ai-overviews/)

**Listings / launches:** [260+ SaaS directories (Position Digital)](https://www.position.digital/blog/saas-directories/) · [Product Hunt launch playbook 2026](https://dev.to/iris1031/product-hunt-launch-playbook-the-definitive-guide-30x-1-winner-48g5) · [HN/Show HN marketing](https://business.daily.dev/resources/hacker-news-marketing-developer-tools-show-hn-launch-day-sustained-coverage/) · [G2 acquires Capterra/GetApp](https://www.prnewswire.com/news-releases/g2-to-acquire-capterra-software-advice-and-getapp-from-gartner-302673901.html) · [FTC fake-review rule](https://www.ftc.gov/legal-library/browse/rules/rule-consumer-reviews-testimonials) · [Blastra — directory automation w/ human review](https://blastra.io/)

**Niche channels:** [SIL software community](https://community.software.sil.org/) · [support.bible / Paratext](https://support.bible/) · [faith.tools](https://faith.tools/) · [FBAI](https://forum-intl.org/) · [LINGUIST List](https://linguistlist.org/) · [SBL](https://www.sbl-site.org/) · [JOSS](https://joss.theoj.org/) · [OLAC](http://www.language-archives.org/)

**Autonomy / HITL:** [Truto — HITL approval workflows](https://truto.one/blog/implementing-human-in-the-loop-approval-workflows-for-consequential-saas-api-actions/) · [StackAI — HITL design patterns](https://www.stackai.com/insights/human-in-the-loop-ai-agents-how-to-design-approval-workflows-for-safe-and-scalable-automation) · [AI agent marketing: real vs vaporware (Averi)](https://www.averi.ai/how-to/ai-agent-marketing-how-autonomous-ai-is-changing-content-ops-in-2026)
