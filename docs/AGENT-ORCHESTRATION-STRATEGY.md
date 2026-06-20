# Autonomous Agent Orchestration on this Repo — L1 / L2 / L3

_A strategy memo for running AI agents that continuously improve **Aquilla** (codex-web-prototype) — both the **code** and the **distribution**, treated as equal priorities. Grounded in this repo's actual mechanics and in published agent-loop best practice (Anthropic, Cognition, OpenAI, Cursor, Sourcegraph, ZenML, Google, AWS). Sources at the bottom._

---

## 0. What "the kinds of improvements we see" actually are

Reading the git history, the Linear pipeline, the skills, and `docs/swarm/`, the improvement profile is concrete:

- **Full-stack vertical feature slices tied to `FRO-###` Linear issues** — rules engine (plain-language authoring, multi-pass LLM extraction, doc import), terminology library (interlinear alignment via Dice + IBM Model 1 EM, violation glyphs), back-translation, sync/outbox correctness. ~44% of recent commits are `feat`, ~15% `fix`, ~19% `docs`.
- **Each feature spans the whole stack**: a D1/Neon migration → an auth-worker/sync-worker route → a `src/lib` module → a React hook → a component, with RBAC enforced in three places. Highest churn: `src/components`, `src/hooks`, `src/lib/sync`.
- **Verification-gated swarm merges** are already the integration mechanism: `swarm/wN-*` worktrees → `wN-integration` → `main`, gated by tsc + vitest + build + e2e smoke + dev-stack UI verification.
- **Living docs are first-class output** — `docs/swarm/ORCHESTRATION.md` and `TRACES.md` are inputs to the next wave, not just records.
- **~23% of commits already carry a `Co-Authored-By: Claude` trailer.** Agents are already a big fraction of the labor.
- **The glaring gap: there is essentially zero marketing/distribution work in this repo.** No landing-page churn, no release-notes pipeline, no SEO/onboarding/content. Given that you rank code and distribution as equal, this is the single biggest unaddressed surface — and the easiest for agents to attack, because most of it is read/generate-heavy and embarrassingly parallel.

So "an agent that constantly produces the kinds of improvements we see" means: **drain a well-specified backlog of full-stack slices, behind hard verification gates, while keeping docs current — and (new) do the same for distribution.**

---

## L1 — Less is more: one agent, one loop, one gate

**Thesis:** The minimum viable autonomous improver is *not* an orchestra. It is a **single-threaded agent running the loop you already have (`/issue`) on a timer**, with a verification gate it cannot bypass. This is the Anthropic "start simple, add complexity only when it demonstrably improves outcomes" position and the Cognition "single-threaded agents are the most reliable unit for write-heavy work" position — and for coding (write-heavy, tightly-coupled) they are both right.

**The loop (runs on every reboot / interval):**

1. **Load durable state** — read `docs/swarm/TRACES.md`, recent git log, and the Linear `Todo` queue. Memory lives in git + Linear + files, never only in the context window.
2. **Pick exactly one well-specified item** (one `FRO-###`, or self-file one via `/issue debug "…"`). One feature at a time — the #1 long-running-agent failure mode is "attempts too much at once."
3. **Explore → plan → implement** on a branch (Anthropic's four phases; Sourcegraph's 7-step loop).
4. **Verify against the existing gate** — `tsc` clean, `vitest` green, `build` passes, e2e smoke, and `verify-dev-change` driving the real seeded UI. *The gate is the whole point*: "the difference between a session you watch and one you walk away from."
5. **Commit, push, open PR, update `TRACES.md` + Linear comment, stop.**

**What it takes — and you already have most of it:**

| Need | Status in this repo |
|---|---|
| Work queue | ✅ Linear `FrontierR&D / Prototype Debugging`, `Dispatched` status as a lock |
| Verification gate | ✅ pre-push smoke + `web-ci.yml` (tsc/vitest/build) + `verify-dev-change` |
| Durable memory | ✅ `docs/swarm/TRACES.md`, Linear comments, git |
| The loop itself | ✅ the `/issue` skill *is* this loop |
| **A scheduler/trigger** | ❌ **missing** — no cron/scheduled session. This is the one piece to add. |

**Guardrails (non-negotiable even at L1):**
- Scope to **low-blast-radius, reversible** changes. Never autonomously touch DB migrations, prod deploys, secrets, or dependency bumps — those are human-gated (see HITL below).
- **Circuit breaker / budget cap**: `max_turns`, `max_budget_usd`, loop detection. (A real production team burned $127/wk → $47k/wk from two agents pinging each other; cost caps are not optional.)
- **No test manipulation**: the agent fixes code, never edits tests to go green.

**The honest limit of L1:** it produces incremental, ticket-shaped improvements (bug fixes, polish, small features, test coverage) and keeps docs current. It will **not** invent the roadmap, and it depends entirely on a human keeping the backlog stocked with *good specs* — vague tickets are the dominant cause of agent failure. **"Less is more" here is literal: the leverage is loop × gate × good queue. Do not add a framework, a planner, or six agents yet. A fat skill or a bloated `CLAUDE.md` is a liability, not an asset.**

---

## L2 — What a 100x agent-orchestra engineer builds

**Thesis:** Now build the orchestra — but designed by someone who *knows the failure modes*. The whole field's evidence converges on one architecture: **fan out cheap agents to gather (Anthropic), funnel all writes through a single coherent thread (Cognition).** Multi-agent wins +81% on parallelizable work and *loses up to 70%* on sequential work; error compounds 17x with decentralized agents but only 4.4x with centralized coordination. So: **centralized conductor, parallel scouts, single-threaded writers.**

This is where **skills and code earn their keep** — skills are the orchestra's muscle memory; infra code is the harness that makes it safe to walk away.

### The org chart (mostly agents)

1. **Conductor — Opus, single, persistent.** Owns decomposition into file-disjoint waves, scheduling, the STOP checklist, and *sole authority to merge to `main` / deploy*. State in `docs/swarm/ORCHESTRATION.md`. **This is `/swarm`, productionized.** Only one actor promotes — this is what contains error amplification.
2. **Workers — Sonnet, in isolated git worktrees, file-disjoint.** Each implements one vertical slice, single-threaded with full context (Cognition). Parallel *across* disjoint files, never *on* the same file — that is exactly the "Mario background vs. inconsistent bird" failure Cognition warns about.
3. **Scouts — Haiku, cheap, parallel, isolated context.** Backlog triage, codebase search, bug repro, spec gathering, test-plan drafts, classification. Each returns a 1–2k-token distilled summary, not its raw transcript ("artifact" pattern). This is the cost-tiering / cascade move: cheap first, escalate to a stronger tier only on failure.
4. **Evaluators — the verification loop.** Drive the real UI (`verify-dev-change` / Playwright MCP), run the gate, and gate promotion. Add an **adversarial "Inspector" pass** after workers — one study caught 96.4% of errors before they propagated. Verification is rules-based (lint/test/build/typecheck) wherever possible — "preferable to fuzzy feedback."
5. **The Broadcast pipeline — equal to Build.** Today distribution is empty. Stand up a parallel workstream with *its own* Linear project and *its own* gates: landing page, changelog→release-notes→blog, demo scripts/video, SEO, social, onboarding flows, docs site. This work is read/generate-heavy and embarrassingly parallel → **ideal for Haiku/Sonnet fan-out with one Opus editor enforcing voice and taste.** Its verification gate is concrete too: does the page deploy? Lighthouse score? does the demo actually run? does onboarding complete end-to-end?

### Skills as the API surface (keep them few and sharp)

You already have the right primitives: `/issue`, `/swarm`, `/e2e-add`, `verify-dev-change`, `swarm-orchestration`, `deep-research`. The 100x move is **discipline, not proliferation**: version them, keep each one thin, and treat them as the contract between conductor and workers. Add only what's missing:
- `/ship` — release notes + deploy + announce (makes "shipped," not "PR opened," the terminal state).
- `/distribute` — the Broadcast-pipeline entry point.
- `/triage` — cheap Haiku backlog grooming that keeps the queue well-specified (directly attacks L1's dependency on a human stocking good specs).

### Infra code the engineer writes (the harness)

- **The missing scheduler** — a GitHub Action on a schedule (and on PR webhooks, already supported here) that boots the Conductor on interval and on events.
- **Observability before problems** — structured run logs, cost-per-run, success rate, per-wave traces. `TRACES.md` is the poor-man's version; make it real. (ZenML's 1,200-deployment data and Google both say: build tracing *before* you need it.)
- **Circuit breakers + budget caps + idempotency** — max iterations, $/run caps, loop detection; `Dispatched`-as-lock prevents double-claims; idempotency keys for any external side effect.
- **Context-rot management** — fresh context per wave (rot measurably starts at ~32k, bites by 50–150k tokens regardless of model). Worktree-per-slice already enforces this; add compaction that keeps "architectural decisions, failing test names, key stack frames" and discards raw logs.
- **The STOP checklist as code** — tsc clean / vitest green / build / e2e smoke / every claim true on the golden path — gating promotion (already in `/swarm`).

### Human-in-the-loop, scaled to blast radius
Autonomy scales with reversibility. Low-blast-radius, reversible changes → fully autonomous. High-blast-radius → checkpoint-and-approve: **migrations, prod deploys, secrets, dependency bumps, anything touching customer data on Neon prod, force-push.** Start supervised; widen autonomy as reliability proves out (the cross-industry consensus ramp).

**What L2 buys:** parallel throughput on **both code and distribution**, with a single conductor keeping the product coherent — at ~15x the token cost of a chat, which is *only* justified because the cheap tier does the parallel breadth.

---

## L3 — The Steve Jobs lens: taste, integration, and delegated research

**Thesis:** The next level is **not more agents.** When agents make throughput free, throughput stops being the constraint — **taste and integration become the scarce resources.** The L3 move is to run the *company* as the product. Jobs's principles map cleanly onto agent-era software, and they answer your "code == distribution" point directly.

1. **"Real artists ship."** The loop's terminal state is **shipped and announced**, not "PR merged." Distribution is part of *done*. This is why Broadcast is a first-class L2 pipeline, not an afterthought.
2. **The whole widget.** Jobs owned hardware + software + retail so the seams disappeared. The agent company owns **spec → code → deploy → release notes → landing page → onboarding → support** as one integrated experience. The Conductor with taste integrates the whole thing; fragmenting into disconnected agent silos reintroduces exactly the incoherence Cognition warns about (dispersed decisions = a product that feels stitched together).
3. **Focus is saying no.** A cheap agent fleet will generate infinite *mediocre* features. The scarce act becomes **rejection**. The human + an Opus "taste layer" should spend most of their budget saying no and polishing, not generating. This is the "80/95 problem": agents reach 80% fast; the last 15% — the feel, the "it just works" — is the entire differentiator and is where human/Opus judgment is spent. (Sourcegraph calls the same thing the "80% problem": agents nail the visible work and miss the invisible 20% — auth, audit logging, edge cases. Taste is what catches the 20%.)
4. **Start from the experience, work back to the tech.** The backlog must not be agents staring at code inventing work. **PostHog is already integrated** — wire the loop to telemetry: scouts mine real user friction, the Conductor turns it into an opinionated roadmap. Demand pulls the roadmap; the repo doesn't push it.
5. **Demo-driven.** Jobs designed for the demo. The verification bar becomes "does it demo *beautifully*," not merely "tests pass." `verify-dev-change` driving the real UI is the seed; grow it into demo-quality gating.

**Research as a first-class, always-delegated, cheap activity (your explicit L3 instruction):**
- **Always delegate research to faster/cheaper agents** — exactly as this very memo was produced: I fanned out 5 Haiku/Sonnet search agents in parallel, each in isolated context, returning distilled briefs, then synthesized with judgment. That is the L3 pattern in miniature.
- Standing research surfaces: competitor/positioning analysis, **domain research** (this is a Bible-translation / terminology / interlinear-alignment product — deep, specialized linguistic domain knowledge compounds), user-journey mining from PostHog, SEO/keyword and distribution-channel research, best-practice scans.
- Research feeds **both** the product roadmap **and** the distribution engine (positioning, content, messaging) — equal weight, per your priority.
- `deep-research` already exists in the toolbox; make it a standing capability the Conductor invokes on a cadence.

**The company loop (the alpha agent-orchestration software company, 2026+):**

```
        cheap fan-out research  →  Opus synthesis WITH TASTE  →  opinionated, FOCUSED roadmap
                  ↑                                                          │
          PostHog telemetry                                                  ▼
       (real user friction)                                    ┌──────────────────────────┐
                  ↑                                            │  Conductor (Opus)         │
                  │                                            │  coherence · merge · taste│
                  │                                            └────────────┬─────────────┘
                  │                                  ┌──────────────────────┴───────────────────────┐
                  │                          BUILD pipeline                              BROADCAST pipeline
                  │                    (Sonnet workers, worktrees,                  (cheap fan-out + Opus editor:
                  │                     file-disjoint, single-write)                 site, release notes, demos, SEO)
                  │                                  │                                          │
                  │                          verification gate                          distribution gate
                  │                    (tsc/vitest/build/e2e/UI/Inspector)      (deploys? Lighthouse? demo runs? onboarding completes?)
                  │                                  └──────────────────┬───────────────────────┘
                  └───────────────────────────  SHIP + ANNOUNCE  ◄──────┘  →  measure (PostHog)  →  repeat
```

- **Humans (1–3):** vision, taste, the final no, key relationships. The Jobs layer.
- **Everything durable** in git + Linear + `docs/swarm/`. Nothing lives only in a context window.

**The 2026 differentiator** is not *having* agents — everyone will. It is: **(a) verification you can trust, (b) taste/curation that says no, (c) treating distribution as equal to code, (d) cheap-delegated research feeding an opinionated roadmap.** Less is more at L1; sharp skills + a disciplined orchestra at L2; taste + research + shipping fused into one company at L3.

---

## Concrete next steps (in priority order)

1. **L1, this week:** add the missing **scheduler** (GitHub Action on a cron) that runs `/issue next` behind the existing gate, with a budget cap. Everything else for L1 already exists.
2. **Stock the queue:** add `/triage` (cheap) so the backlog stays well-specified — this is L1's only real dependency.
3. **Stand up Broadcast:** create a `Distribution` Linear project and a `/distribute` + `/ship` skill. This closes the biggest gap (zero marketing in-repo) and is the cheapest, most parallel win.
4. **L2 hardening:** add run-level observability + circuit breakers to `/swarm`; add the adversarial Inspector pass; codify HITL gates for the high-blast-radius list.
5. **L3 standing loop:** wire PostHog friction → `deep-research` (delegated, cheap) → Opus roadmap synthesis on a weekly cadence.

---

## Sources

**Anthropic (primary):** [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) · [How We Built Our Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system) · [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices) · [Building Agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk) · [Writing Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents) · [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

**Contrarian / single-vs-multi:** [Cognition — Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) · [Cognition — Devin 2025 Performance Review](https://cognition.com/blog/devin-annual-performance-review-2025) · [Single-Agent Outperforms Multi-Agent under Equal Token Budgets (arXiv)](https://arxiv.org/abs/2604.02460) · [Zartis — The Compounding Errors Problem](https://www.zartis.com/the-compounding-errors-problem-why-multi-agent-systems-fail-and-the-architecture-that-fixes-it/) · [O'Reilly — The Hidden Cost of Agentic Failure](https://www.oreilly.com/radar/the-hidden-cost-of-agentic-failure/) · [OpenAI — A Practical Guide to Building Agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)

**Coding-agent architectures:** [Sourcegraph — Agentic Coding in 2026](https://sourcegraph.com/blog/agentic-coding) · [Cursor — How Cursor Shipped its Coding Agent (ByteByteGo)](https://blog.bytebytego.com/p/how-cursor-shipped-its-coding-agent) · [Augment — Harness Engineering](https://www.augmentcode.com/guides/harness-engineering-ai-coding-agents) · [MindStudio — AI Coding Agent Harness (Stripe/Shopify/Airbnb)](https://www.mindstudio.ai/blog/ai-coding-agent-harness-stripe-shopify-airbnb)

**Production failure modes / cost / guardrails:** [ZenML — What 1,200 Production Deployments Reveal About LLMOps in 2025](https://www.zenml.io/blog/what-1200-production-deployments-reveal-about-llmops-in-2025) · [Google — Production-Ready AI Agents: 5 Lessons](https://developers.googleblog.com/production-ready-ai-agents-5-lessons-from-refactoring-a-monolith/) · [OWASP — Top 10 Risks for Agentic AI](https://genai.owasp.org/2025/12/09/owasp-genai-security-project-releases-top-10-risks-and-mitigations-for-agentic-ai-security/) · [Triage — Routing SWE Tasks to Cost-Effective LLM Tiers (arXiv)](https://arxiv.org/html/2604.07494v1) · [StackOne — Agent Suicide by Context](https://www.stackone.com/blog/agent-suicide-by-context/)
