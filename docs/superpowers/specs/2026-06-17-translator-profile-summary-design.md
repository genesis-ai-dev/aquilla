# Translator profile + vetted-resource summary buttons

Date: 2026-06-17
Status: approved → implementing

## Motivation

A presenter (SIL/UBS Paratext cohort) wants the AI to summarize a passage/book
for a translator using (1) vetted reference resources and (2) a **translator
profile** (age, gender, education, religious background, translation experience,
geographical setting, language). The summary must come back in the translator's
language and be tailored to who they are.

We already have the two ingredients:

- **Vetted resources** — the Aquifer integration (bibletranslation.org) is wired
  into the **agent** path (`execute.aquifer`), gated by the project setting
  `bibleResourcesEnabled`. The simple chat path has no tools, so summaries that
  use vetted resources must run through the **agent**.
- **A place for per-user prefs** — device-scoped localStorage prefs
  (`analytics-consent.ts`, `dock-rail-position.ts`) and an unused server
  `users.preferences` column.

There is no translator profile yet, and the project setting `main_chat_language`
("Assistant language") exists in the UI but is **never injected into any prompt**
— chat language has never actually worked.

## Design

### 1. Translator profile store (`src/lib/translator-profile.ts`)

A storage-agnostic module mirroring `analytics-consent.ts` (localStorage +
`CustomEvent` so all hook instances stay in sync), plus `useTranslatorProfile()`.

```ts
interface TranslatorProfile {
  responseLanguage?: string  // the one functionally-wired field
  age?: string
  gender?: string
  educationLevel?: string
  religiousBackground?: string
  translationExperience?: string
  geographicalSetting?: string
  otherInfo?: string         // "other relevant information" from the slide
}
```

All fields optional, free-text, trimmed + capped (280 chars) on write and again
before sending to a model. `profileForPrompt()` returns the sanitized object or
`null` when empty.

**Server-sync progression path:** this module is the single read/write boundary.
Later, persist under `users.preferences.translatorProfile` (new `PATCH /auth/me`)
and hydrate from `/auth/me` — only the module internals change; callers stay put.

### 2. Profile editor UI

A "Translator profile" section on `src/pages/Preferences.tsx` (the existing
per-user prefs page): an "Assistant language" input + the demographic fields,
all optional, with a one-line privacy note that these are sent to the AI to
tailor summaries.

### 3. Profile → prompt (formatted as JSON)

The profile is injected into the system prompt **as a JSON object** (unambiguous
key/values for the model), under a heading, followed by an explicit
`Respond to the user in <language>.` line.

- **Chat** (`chat-service.ts`, client): `buildChatMessages` gains
  `translatorProfile` + `responseLanguage`. Sent on every chat turn.
- **Agent** (`schema-card.ts`, server): `AgentPromptContext` gains
  `translatorProfile` + `responseLanguage`. The wire request
  (`AgentRunRequest`) carries `translatorProfile`; the route caps each field
  (never trust the client) and passes it through. Sent on every agent run.

The block builder is mirrored client/server (like `protocol.ts`); the heading
text is identical so the two stay recognizably parallel.

### 4. Language precedence ("profile overrides project")

- **Chat:** `responseLanguage = profile.responseLanguage || main_chat_language`.
  This wires the dormant `main_chat_language` setting for the first time, as the
  fallback under the user profile.
- **Agent:** `responseLanguage = profile.responseLanguage` only. The agent never
  had a response-language setting, and defaulting to the project *target*
  language would force target-language replies on owners/PMs who don't read it
  (two-audiences constraint). So the profile is the sole driver; unset → current
  English-default behavior.

### 5. Summary buttons

- `ChatComposer` gains an optional `suggestedActions` prop → a chip row directly
  above the textarea (hidden when empty; zero change for other callers). Buttons
  are disabled while streaming or unconfigured.
- `ChatDockPanel` builds the actions when a **scripture file** is open and the
  `agent` prop is present: **Summarize book** (uses the file context) and
  **Summarize chapter** (uses the focused cell's chapter ref; disabled if no
  verse is focused). The same actions render above the composer in **both** chat
  and agent modes.
- Clicking switches the dock to **Agent** mode and sets `pendingAgentPrompt`;
  `AgentDockView` consumes it (`pendingPrompt` + `onPendingPromptConsumed`) and
  calls its existing `sendPrompt`. The agent already receives `fileId`/`cellId`
  context, so the prompt only states scope + the slide's four-part structure
  (Key Meaning / Important Insights / Application / Translation Notes), in
  `src/lib/summary-prompts.ts`.
- Scripture detection (client): `type ∈ {usfm, ebible, helloao}` OR a
  `corpusMarker` is set OR the focused cell has a canonical ref.
- If `bibleResourcesEnabled` is off, summaries still work (model knowledge only),
  no error — the agent simply isn't told the aquifer branch exists.

### 6. Testing

- `translator-profile.test.ts`: defaults, sanitize (trim/cap/drop-empty),
  `profileForPrompt` null-when-empty, `effectiveResponseLanguage` precedence,
  change event fires.
- `summary-prompts.test.ts`: book/chapter prompts name the scope + carry the
  four-part structure.
- `chat-service` test: profile JSON + `Respond in <lang>` injected; precedence.
- `agent-schema-card.test.ts`: profile JSON block + response-language line;
  capping; absent profile → no block; still ≤250 lines.

## Out of scope (v1)

- Server-sync of the profile (path documented above).
- Agent falling back to `main_chat_language` (chat does; agent uses profile only).
- A "Bible resources are off — enable for richer summaries" nudge.
