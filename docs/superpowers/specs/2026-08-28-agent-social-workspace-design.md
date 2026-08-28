# Agent social workspace — design (2026-08-28)

Source: 2026-08-28 team meeting transcript (12:46–12:55). Approved direction: make the
multi-agent surface read like a social chat (Telegram/Discord), not a technical console.

## Goals (from the transcript)

1. **Social team view**: named agents with avatars — Drafter, Reviewer, Coordinator —
   whose work appears as browsable threads with plain-language messages.
2. **No raw commands in chat**: the agent chat must not surface raw SQL in the
   collapsed activity line (raw stays one click away).
3. **Warmer empty states**: the agent intro presents the team; a "nothing to do"
   tool reply suggests a next step instead of dead-ending.
4. **Navigation**: the sidebar Agent rail item must respond while the workbench is
   open (active state + toggle back to editor); example prompts say they only
   prefill the composer.

## Non-goals (v1)

- No backend agent identity (`actor` on events) — personas are a deterministic
  client-side presentation over existing autopilot phases and chat tool kinds.
- No per-verifier messages (votes are aggregated server-side before emission).
- No chat-session history list (server has no list endpoint).
- The workbench default tab stays Chat; Team is the first tab. Revisit after use.

## Architecture

**Personas** (`src/lib/agent/personas.ts`, pure): `drafter | reviewer | coordinator`,
each with i18n name/tagline keys, lucide icon, tint classes. Mapping:
- pipeline regions: reading/drafting → drafter, checking → reviewer, staging → coordinator
- autopilot event kinds: span_started/drafts_staged/span_outcome → coordinator,
  scene_ready → drafter, phase → by region; run_created/run_state/llm/steering → skipped
- chat tool kinds: read/examples/search/docs/aquifer/draft → drafter, sql/emit → coordinator

**Feed transform** (`src/lib/agent/social-feed.ts`, pure): `ContextualRunActivity` →
`TeamFeedMessage[]` ({persona, at, body: typed union with spanLabel/count/reasons/brief
excerpt}). Consecutive duplicate phase messages dedupe; unknown kinds are skipped.

**Team view** (`src/components/agent/TeamThreadsView.tsx`): Telegram-style two-pane —
left: roster header + pinned "Needs your expertise" row (decisions) + thread list
(one thread per autopilot run, titled by file); right: message feed with
avatar/name/time rows; drafts-staged messages link to review. Data via the same
transport the inspector uses (`fetchContextualRuns`, `fetchContextualRunActivity`,
`fetchContextualDecisions`), 4s poll while visible. States: skeleton loading, team
intro empty state, inline error + retry.

**Chat restyle** (`AgentRunView.tsx`): assistant prose gets a Coordinator
avatar/name header (grouped Discord-style); tool chips become plain-language
activity lines attributed to a persona — SQL summary never renders collapsed;
raw summary/result stay behind the expand.

**Workbench** (`AgentWorkbench.tsx`): tabs = Team | Chat | Project knowledge; a
pending "Ask AI" chip auto-switches to Chat.

**Empty states**: `AgentEmptyState` presents the roster + keeps example prompts with
an explicit "fills the message box" hint. Server: the draft tool's "Nothing to
draft" reply gains a suggested next step (auth-worker/src/lib/agent/tools/draft.ts).

**Navigation**: `resolveSidebarAgentClick` now returns `close-workbench | open-dock`;
clicking the rail Agent item while the workbench is open returns to the editor
(mirrors the rail's collapse idiom). New `railActiveTab` prop on `LeftDock` marks the
Agent rail item active during the takeover without changing which panel is open.

## v2 — the one-channel model (approved direction, 2026-08-28 follow-up)

Ryder's framing after v1 landed: a main orchestrator invokes subagents; subagents
work in threads; the whole thing reads as one chat history; humans can talk to
the orchestrator or drill into a thread and direct a subagent. Simple and clear
beats clever. Synthesis:

**One shared project channel.** The Coordinator is the only agent that speaks at
top level, narrating at intent level. Every delegated piece of work is one main
message that owns a thread; the subagent's play-by-play (tool lines, drafts,
checks) lives in the thread. The main channel IS the team overview — the
worktree series' overview/questions/work panels dissolve into it:
questions-needing-expertise become ordinary Coordinator messages mentioning the
user (Answer affordance, threaded; decision records stay as the data layer);
work status is a chip on the thread's parent message.

**Layout.** `| main chat | optional thread detail |` — opening a thread
collapses main to a narrow spine of avatars at the SAME vertical positions
(temporal order preserved; open thread's parent highlighted). Composer fixed at
the bottom; in thread mode it takes an inline-start margin plus a scope chip
("→ Drafter · GEN 1:1–8") so the send target is unmistakable. Main-channel
composer addresses the orchestrator; thread composer addresses that subagent.

**Transparency (no console).** (1) Agent cards on avatar click: persona's role,
its actual tool list, the standing state it reads (brief, style guide, termbase,
living memory, rules), what it may write (staged proposals only — approval gate
stated on the card). (2) Plain-language receipts inline in threads, raw detail
one expand deeper. (3) State changes are messages that LINK into the existing
state surfaces ("Saved a situation note → Living Memory") — no new state UI.

**Multiplayer.** Every user sees the same durable history; multiple humans can
speak in main and in threads. Requires the server-side thread store — port the
AQU-1049–1052 `team_threads`/`team_decisions` backend (rebased onto dev) as the
message store, broadcast via the per-project ProjectSync DO. Autopilot events
get written into durable threads server-side (replacing v1's client-side
derivation); `sendContextualSteering` becomes the thread-scoped "message the
Drafter" path. Personas stay an open registry keyed to core workflow functions
(Terminology/Audio/Import personas can join later).

**Sequencing.** (1) One-channel presentation + collapse-spine layout on dev
(presentation only). (2) Durable shared history: port the team-threads backend,
write autopilot + chat runs into it, DO broadcast — multiplayer lands here.
(3) Thread-scoped composer wired to steering. (4) Agent cards.

## Testing

Vitest: personas mapping totality (every region/tool kind attributes — the social
view must never show an anonymous actor); social-feed fixtures (persona routing,
dedupe, skip-unknown, ordering); TeamThreadsView RTL with mocked transport
(threads, feed, decisions pin, empty state); AgentRunView (no raw SQL collapsed,
expand reveals raw); AgentEmptyState (roster, prefill behavior); shell-routing
(resolveSidebarAgentClick). Worker: draft-tool empty-reply text. No new smoke
(UI-only; AGENTS.md rule 3); existing agent e2e selectors verified unaffected
("Ask the agent" composer, TabStrip "Agent" tab, data-frame-type attrs unchanged).
