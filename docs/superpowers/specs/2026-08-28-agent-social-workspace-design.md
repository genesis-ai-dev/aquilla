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

## v2.1 — the typical-chat refinement (2026-08-28 notes, shipped)

Ryder's follow-up notes (ChatGPT/Perplexity/Signal references) pulled the
layout onto the standard pattern: the app dock is the slim icon rail; inside
the Team tab, a conversations LIST (Team chat pinned first, one consolidated
"Needs your expertise" conversation, runs newest-first — each row a
medium-weight name, one-line preview, quiet time, and the single primary
accent reserved for counts needing the human) sits beside the ACTIVE
conversation. The v2 collapse-spine was replaced by this persistent list;
dispatch messages in Team chat carry a quiet inline "View updates" affordance
(the replies-badge pattern) instead of being the only entry point; focus mode
hides the list for a centered wide canvas. Monochrome discipline throughout:
identity lives in the tinted avatars, names are plain foreground at medium
weight, activity chips flattened from boxes to quiet rows.

## v2.2 — the three-column layout (2026-08-28 follow-up, shipped)

Ryder's structural observation: per-file conversations duplicated the Files
sidebar. Resolution — `| dock | conversation | optional step inspector |`:

- The conversations list lives in the LEFT DOCK's Agent tab (AgentDockPanel),
  replacing the old compact dock chat entirely: the dock lists, the surface
  talks. A New-conversation control sits in its header; scripture Summarize
  quick actions hand their prompt to the surface chat (pendingPrompt).
- The center is the ACTIVE conversation only. Selection is URL-driven
  (`?conversation=`), so the dock and the surface share one source of truth
  and threads are deep-linkable; a conversation param lands the workbench on
  the Team tab. Entering the agent surface opens the dock's Agent panel (the
  old files-scope-picker takeover and the v2.1 focus toggle are gone — dock
  collapse plays that role).
- Clicking a step opens the STEP INSPECTOR third column: the plain-language
  sentence up top, then collapsed sections holding the receipts — the durable
  event kind/details, the situation note, outcome reasons.
- RE-OPEN BY MESSAGING: a finished run's composer no longer dead-ends for
  CONTRIBUTOR+ viewers — sending starts a fresh run on that file
  (startFileContextualRun) with the message as its first steering direction,
  and selection jumps to the new conversation.
- One shared refcounted poller (team-conversations.ts) feeds both columns.

## v3 — autonomy modes + the react loop (2026-08-28 evening session, Ryder + Daniel)

The functionality-exposure layer: the agent's autonomy is a dial, expressed as
a configurable process graph with parts activated or not.

**Agent mode** (per-project, stored in project settings as `agentMode`,
defaults ALL OFF so merging with "flags off" is just the default):

```ts
agentMode: {
  initiative: boolean   // the autopilot loop may pick up new work on its own
  react: boolean        // watch project events and respond to human input
  scope: "full" | "qa" | "draft"  // what work reactions/initiative may do
}
```

UI presets over those switches: Full autopilot {initiative+react, full} ·
React only {react, full} · QA only {react, qa} · Draft only {initiative,
draft} · Off/manual {}. The mode control renders the switches with the
process graph beneath (view-first; graph customization later, per the
meeting: "we don't have to make a whole way to customize it yet").

**React loop** (server, rides the existing 5-min cron `scheduled()` sweep,
plus a manual "check for updates now" route for immediacy): for each project
with `react` on, read the append-only events table past a per-project cursor,
keep only HUMAN-authored expert input (target commits, validations) older
than a debounce window, group by file, gate for relevance (heuristic v1: any
qualifying events in a discourse file with no active/recent reaction run),
then START a contextual run `initiatedBy: "reaction"` anchored at the
affected cells, seeded with an auto-steering direction naming the trigger
("Reacting to N human edits in <refs>; scope qa → verify and report, do not
redraft unless a check fails"). Existing-run etiquette (shipped): a BUSY run
(running/pausing/waiting) defers the reaction; a PAUSED run is never
overridden — a person asked for quiet; a PARKED run with remaining work is
WOKEN with the reaction steering (continuing its own conversation); an
EXHAUSTED parked run is retired and replaced by a fresh reaction run over the
file's current state. Premise from the meeting: "anytime you have
human expert data injected, there are implications of that." Anti-noise: a
reaction is a THREAD, not notifications — debounce, one open reaction per
file, cooldown between reactions. Never throw into the cron.

**Next step only**: the start route accepts `spanLimit` (run parks after N
spans) — the "translate the next passage, then I look" button.

**UI**: mode control (switches + presets + graph) in the Team surface header,
gated by an `agentModes` experimental flag; reaction conversations badge in
the list ("reacted to your changes", from `initiatedBy === "reaction"`);
"check for updates" + next-passage affordances; editor pill links to its run
conversation. Fixes from the live review: step inspector draggable/wider,
no raw opaque ids anywhere user-facing, duplicate feed-event ids fixed at
the seed + guarded in the feed transform.

**Deferred from the session**: FAB replacing the pill + editor-side thread
accordion; cursor-style revert-from-thread; project-knowledge agent persona;
speculative pre-filling research; graph editing.

## Testing

Vitest: personas mapping totality (every region/tool kind attributes — the social
view must never show an anonymous actor); social-feed fixtures (persona routing,
dedupe, skip-unknown, ordering); TeamThreadsView RTL with mocked transport
(threads, feed, decisions pin, empty state); AgentRunView (no raw SQL collapsed,
expand reveals raw); AgentEmptyState (roster, prefill behavior); shell-routing
(resolveSidebarAgentClick). Worker: draft-tool empty-reply text. No new smoke
(UI-only; AGENTS.md rule 3); existing agent e2e selectors verified unaffected
("Ask the agent" composer, TabStrip "Agent" tab, data-frame-type attrs unchanged).
