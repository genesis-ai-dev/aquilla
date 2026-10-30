// AQU-2263 (Oct 29, second pass): which language the assistant answers in.
//
//   1. the person's own choice (Preferences → Translator profile,
//      "The assistant answers me in …"), sent as translatorProfile.responseLanguage;
//   2. the project's "The assistant answers the team in …", stored in the shared
//      drafting settings as `main_chat_language`;
//   3. as before, the language of the person's latest message (a rule in the
//      prompt, prompt-augment.ts);
//   4. only when that can't be told, the language they use Aquilla in, which
//      the client sends as `appLanguage` (English for an older client).
//
// `reply` is steps 1–2: a language the prompt pins. `whenUnclear` is step 4,
// used only inside step 3's rule.

/** The longest language name any step may put in the prompt. */
const MAX_LANGUAGE_LENGTH = 100

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim().slice(0, MAX_LANGUAGE_LENGTH)
  return trimmed || undefined
}

export function resolveAnswerLanguage(input: {
  personal?: unknown
  team?: unknown
  app?: unknown
}): { reply?: string; whenUnclear?: string } {
  return {
    reply: clean(input.personal) ?? clean(input.team),
    whenUnclear: clean(input.app),
  }
}
