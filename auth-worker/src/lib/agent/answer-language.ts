// AQU-2263 (Oct 29, second pass): which language the assistant answers in.
//
//   1. the person's own choice (Preferences → Translator profile,
//      "The assistant answers me in …"), sent as translatorProfile.responseLanguage;
//   2. the project's "The assistant answers the team in …", stored in the shared
//      drafting settings as `main_chat_language`;
//   3. the language the person uses Aquilla in, which the client sends as
//      `appLanguage`.
//
// None of them (an older client sends no app language) returns undefined, and
// the prompt keeps its rule of following the language of the latest message.

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
}): string | undefined {
  return clean(input.personal) ?? clean(input.team) ?? clean(input.app)
}
