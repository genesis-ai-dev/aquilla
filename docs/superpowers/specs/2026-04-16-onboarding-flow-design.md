# Onboarding Flow: App Wizard + Project Setup Checklist

**Date:** 2026-04-16
**Status:** Draft

## Goal

Give new users a warm, guided path from first visit to productive translation work. Two connected pieces:

1. **App-level onboarding wizard** — one-time, 5-step flow at `/onboarding` that gets a user signed in (or anonymous), named, and into their first project.
2. **Per-project setup checklist** — a persistent drawer that walks through AI provider, instructions, inviting collaborators, and surfaces planned features (project standards, glossary/TM import). Dismissible, re-accessible from settings.

## Non-goals

- Account registration (users sign in to existing Frontier accounts)
- Implementing project standards upload or glossary/TM import (shown as "coming soon")
- Implementing "bring your own keys" AI provider (shown as "coming soon")
- Gating the invite flow behind permissions (future work)

## Reference: desktop app

The codex-editor desktop app has a startup flow state machine (`StartupFlowProvider.ts`) with states: LOGIN_REGISTER → OPEN_OR_CREATE_PROJECT → PROMPT_USER_TO_INITIALIZE_PROJECT → ALREADY_WORKING. We mirror this conceptually but adapt for the web (single-page wizard, no VS Code window chrome).

---

## Part 1: App Onboarding Wizard

### First-run detection

- `localStorage["codex:onboardingComplete"]` — if unset, `Dashboard` redirects to `/onboarding`
- Completing step 5 sets the flag and navigates to the new project
- Users can revisit `/onboarding` manually (it re-runs the wizard, useful for demo/testing)

### Route

`/onboarding` — new route in `App.tsx`, renders `<OnboardingWizard />`.

### Steps

#### Step 1: Welcome

- Hero text: "Welcome to Codex"
- One-liner: "A collaborative translation editor with AI assistance."
- Single "Get Started" button
- Clean, centered layout with generous whitespace

#### Step 2: Sign In (skippable)

- Reuses existing `FrontierLoginForm` component
- Benefits callout above the form:
  - "AI-powered translations"
  - "Sync across devices"
  - "Import projects from Frontier"
- Prominent "Skip for now" link below the form
- On successful login, auto-advance to step 3
- Skip sets the user as anonymous (`session === null`)

#### Step 3: Your Name

- Single text input for display name
- Pre-filled from `session.username` if signed in; empty otherwise
- Placeholder: "Anonymous translator"
- Explanation: "This name appears on your edits and comments."
- "Continue" button (allows empty — defaults to "Anonymous")
- Name stored in `localStorage["codex:username"]` and used as the default for new projects

#### Step 4: First Project

- Inline project creation form (not a dialog):
  - Project name (text input)
  - Source language (text input, e.g. "English" or "en")
  - Target language (text input)
- If signed in, a tab or toggle to "Import from Frontier" that lists remote projects (reuses existing `RemoteProjectsSection` or a simplified version)
- "Create Project" / "Import" button
- This step is NOT skippable — a project is required to proceed

#### Step 5: You're Ready

- Celebration moment (confetti animation or a success illustration)
- Summary: "Project created. Let's set it up."
- "Start Translating" button → navigates to `/project/:id/file/:fileId` (or `/project/:id` if no files yet)
- Sets `localStorage["codex:onboardingComplete"] = "true"`

### Wizard layout

- Centered card, max-width ~480px
- Step indicator at top (dots or numbered progress, e.g. "Step 2 of 5")
- Back button on steps 2-5 (except step 1 which has no "back")
- Animated transitions between steps (simple fade or slide)

---

## Part 2: Per-Project Setup Checklist

### When it appears

- Opens automatically when entering a project where `setupChecklistDismissed !== true`
- After the onboarding wizard creates the first project and navigates to the workspace, the checklist drawer opens immediately
- On subsequent visits, if not dismissed, it opens again

### Drawer behavior

- Slides in from the right (same as `RuleDrawer`, `CommentsDrawer`, `HistoryDrawer`)
- Width: ~320-360px (matches existing drawers)
- Header shows progress: "Setup: 2/3 complete" (counts only active items, not "coming soon")
- Each item is an accordion section — click to expand and configure
- Completing an item shows a checkmark and collapses the section
- "Dismiss checklist" button at the bottom — permanently hides for this project
- Closing the drawer (X button) hides it for the current session but does not dismiss permanently

### Re-access

- Project Settings page gains a "View setup checklist" button (always visible)
- When the checklist is not dismissed, a small pill in the Toolbar shows progress (e.g. "Setup: 1/3")
- Clicking the Toolbar pill opens the drawer

### Checklist items

#### 1. Choose AI Provider (active)

Three radio-style cards:

- **Frontier AI** — "Recommended" badge. If signed in, auto-selects and shows "Connected as {username}". Configures `completionSettings.endpoint` to the Frontier completion URL.
- **Custom endpoint** — Expandable fields: URL, model name, max tokens, temperature. For users running local LLMs or using other APIs.
- **Bring your own keys** — "Coming soon" pill, disabled. Brief description: "Use your own API keys for OpenAI, Anthropic, etc."

Completion condition: `completionSettings.endpoint` is a non-empty string.

#### 2. Set AI Instructions (active)

- Textarea for `completionSettings.systemPrompt`
- Pre-filled with a sensible default prompt (the existing default from `CompletionSettings`)
- Character count indicator
- "Save" button (or auto-save on blur)

Completion condition: `completionSettings.systemPrompt` is a non-empty string (the default counts).

#### 3. Invite Collaborators (active)

- Reuses the existing share-link creation flow from `SharePanel`
- Shows a "Create share link" button if no links exist
- Lists existing share links if any
- Brief explanation: "Share this link with translators and reviewers to collaborate in real-time."

Completion condition: at least one share link exists for the project (checked via `listShares(projectId)`).

#### 4. Upload Project Standards (coming soon)

- Disabled accordion section with "Coming soon" pill
- Description: "Upload style guides, glossaries, and translation standards that AI will follow."
- No expandable content — just the description

#### 5. Import Glossary / Translation Memory (coming soon)

- Same treatment as above
- Description: "Import existing translation memories or glossaries to improve consistency."

### Completion state derivation

Checklist completion is derived from existing project state — no separate tracking needed:

- AI provider: `Boolean(project.completionSettings?.endpoint)`
- AI instructions: `Boolean(project.completionSettings?.systemPrompt)`
- Collaborators: `listShares(projectId).length > 0` (async, cached)
- Coming-soon items: always "incomplete" (don't count toward progress)

Progress display: "2/3 complete" (denominator = active items only, currently 3).

### Data model

One new field on `ProjectRecord`:

```ts
setupChecklistDismissed?: boolean
```

---

## Part 3: Anonymous Mode Behavior

### Sparkle button tooltip

When `session === null` (anonymous user), the `SparkleButton` tooltip in `EditorTable` changes to:

- Currently: `"Configure LLM in settings"` (when not configured)
- New: `"Sign in for AI translations"` (when anonymous)

Same treatment for the batch-complete drag tooltip.

### Header login button

`Toolbar.tsx` (the project workspace header) gains a login/signup button when the user is not signed in. Reuse the `HeaderAuth` component from `src/components/git-import/HeaderAuth.tsx` or extract its login-icon button pattern. Position: right side of the toolbar, near the settings button.

---

## Architecture

### New files

- `src/components/onboarding/OnboardingWizard.tsx` — step state machine, layout shell
- `src/components/onboarding/steps/WelcomeStep.tsx`
- `src/components/onboarding/steps/SignInStep.tsx`
- `src/components/onboarding/steps/NameStep.tsx`
- `src/components/onboarding/steps/ProjectStep.tsx`
- `src/components/onboarding/steps/ReadyStep.tsx`
- `src/components/onboarding/SetupChecklistDrawer.tsx` — drawer shell, accordion layout
- `src/components/onboarding/checklist/AiProviderStep.tsx`
- `src/components/onboarding/checklist/AiInstructionsStep.tsx`
- `src/components/onboarding/checklist/InviteStep.tsx`
- `src/components/onboarding/checklist/ComingSoonStep.tsx` — reusable shell for disabled items
- `src/hooks/useSetupChecklist.ts` — derives completion state from project + shares

### Modified files

- `src/App.tsx` — add `/onboarding` route
- `src/components/Dashboard.tsx` — redirect to `/onboarding` when `localStorage["codex:onboardingComplete"]` is unset
- `src/components/ProjectWorkspace.tsx` — mount `SetupChecklistDrawer`, pass open state
- `src/components/Toolbar.tsx` — add setup progress pill + login button for anonymous users
- `src/components/EditorTable.tsx` — adjust sparkle tooltip for anonymous users
- `src/components/ProjectSettings.tsx` — add "View setup checklist" button
- `src/lib/parsers/types.ts` — add `setupChecklistDismissed?: boolean` to `ProjectRecord`

### No new dependencies

Everything is built with existing primitives: React state, `@base-ui/react` for accordions if needed (already in deps), Tailwind for styling, existing `FrontierLoginForm` and `SharePanel` components for reuse.

---

## Testing

- **`useSetupChecklist`** — unit test: derives correct completion state from various `CompletionSettings` shapes and share counts.
- **Onboarding wizard** — manual smoke: run through all 5 steps, verify skip, verify back button, verify localStorage flag, verify redirect.
- **Setup checklist** — manual smoke: verify auto-open on first project entry, verify completion detection, verify dismiss persistence, verify re-access from settings.
- **Anonymous sparkle** — manual: verify tooltip text when not signed in.
