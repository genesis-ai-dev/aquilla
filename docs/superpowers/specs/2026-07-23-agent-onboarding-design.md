# Agent onboarding: rich empty state + help.aquilla.app guide page

**Date:** 2026-07-23
**Motivation:** A real user (Benz, Tamil IRV) asked "how will this work? do you
have a user guide?" when pointed at the agent. The agent panel's empty state is
one sentence and there is no docs page — the feature is not self-explanatory.

## Part 1 — Rich empty state in the agent chat (this repo)

`AgentDockView` is the single chat surface for both the left-dock panel and the
full-screen workbench, so one change covers both mounts.

### New component: `src/components/agent/AgentEmptyState.tsx`

Replaces the bare icon+sentence branch in `AgentDockView.tsx` (~line 211),
signed-in case only; the "Sign in to use the agent." state is unchanged.

Content (compact card, scrollable in short docks, muted styling to match dock):

- One-line intro: the agent works inside this project — it can search, draft,
  and check; every change arrives as a proposal **you** review and apply.
- 3–4 example prompts as clickable chips. Clicking **prefills the composer**
  (never auto-sends — user sees/edits the prompt; no surprise credit spend).
- The four slash commands from `src/lib/agent/slash-commands.ts`
  (`/draft`, `/check`, `/find`, `/status`) with their one-line descriptions —
  rendered from `SLASH_COMMANDS`, not duplicated text.
- Footer link "User guide →" to `${DOCS_URL}/ai-and-audio/ai-agent/` using the
  same `VITE_DOCS_URL` fallback pattern as `HelpMenu.tsx`.
- "Don't show this again" — persists `aq.agent-guide-dismissed.v1` = "1" in
  localStorage. When dismissed, render the previous minimal empty state plus a
  persistent small "User guide" link so docs stay reachable.

### Wiring

- `ChatComposer`: extend `ChatComposerHandle` with `insertText(text: string)`
  (set editor content + focus). `AgentEmptyState`'s prompt chips call it via
  the existing `composerRef` in `AgentDockView`.
- No changes to run/proposal/session logic.

### Tests (vitest, happy-dom)

- Renders intro, slash commands, guide link when not dismissed.
- Dismiss hides the guide, persists the flag; re-mount respects it.
- Prompt chip click calls the prefill callback with the prompt text.

## Part 2 — Docs page (aquilla-docs-kieran repo)

**Superseded during implementation:** pulling origin/main brought in a complete
"Automation" section (`automation/using-the-agent.mdx`,
`agent-memory-and-brief.mdx`, `approving-agent-changes.mdx`) covering
everything below. The guide link targets `/automation/using-the-agent/`; the
remaining docs work was the copilot↔agent cross-links and pushing the staged
branding edits.

Original plan — new `src/content/docs/ai-and-audio/ai-agent.mdx`:

- What it is; how it differs from the inline **AI copilot** (drafting
  suggestions in the cell) — agent = conversational, project-wide, tool-using.
- How to open it (dock panel / workbench).
- Example tasks: find inconsistent renderings, draft a chapter, check
  translated cells against source, progress status, harmonizing parallel
  passages, finding revision candidates from validated edits.
- Slash commands table.
- The propose → review → apply flow (nothing changes without your approval),
  role permissions in one line.
- Memory proposals, credits (org credits dial), model note.
- Caution block matching `ai-copilot.mdx` tone.

Cross-links: a short "Looking for the chat agent?" note on `ai-copilot.mdx`,
and the reverse on the new page. Add nav entry if the sidebar is explicit in
`astro.config.mjs` (verify; Starlight may autogenerate).

Ships together with the already-staged de-scripture branding edits
(README.md, what-is-aquilla.md). Verify with the repo's build script, then
commit and push to main (auto-deploys to help.aquilla.app).

## Out of scope

- Coach-mark tours / overlays.
- Renaming or restructuring the copilot docs page.
- Any agent behavior changes.
