// AQU-2217 — recognise a model refusal in a reply that was supposed to be a
// translation, so the draft paths can fail visibly instead of committing the
// refusal boilerplate as the cell's target text.
//
// Pure and dependency-free so the auth-worker can import it directly via a
// relative path (like strip-trailing-usfm-markers).
//
// The bar is deliberately high: these patterns are anchored to the START of
// the reply and each one needs BOTH a refusal verb ("cannot", "can't", "am
// unable to", …) AND the thing the model declines ("assist", "help",
// "comply", "that request", …). A reply that merely contains "sorry", or a
// line of dialogue that happens to say "I cannot go with you", is a real
// translation and must pass through. The flip side is that this only catches
// the English vendor boilerplate (OpenAI/Anthropic/Gemini variants) — a
// refusal phrased in the target language is not detectable here.

/** Refusal verbs: "I cannot", "I can't", "I'm unable to", "I won't", … */
const CANT = String.raw`(?:cannot|can ?not|can't|am unable to|am not able to|won't|will not|must not)`

/** Apologetic openers the vendor boilerplate starts with. */
const SORRY = String.raw`(?:i'm sorry|i am sorry|i'm afraid|i am afraid|sorry|unfortunately|my apologies|i apologi[sz]e)`

/** What the model says it will not do. */
const OBJECT = String.raw`(?:assist|help|comply|fulfill?|provide|continue|complete|translate|answer|generate|create|produce)`

/**
 * Each pattern matches the whole reply from its first character. Keep them
 * self-sufficient — the table in `refusal.test.ts` is the specification.
 */
const REFUSAL_PATTERNS: readonly RegExp[] = [
  // "I'm sorry, but I cannot assist with that request." / "Sorry, I can't help with this."
  new RegExp(String.raw`^${SORRY}\b[,.!:;—-]*\s*(?:but\s+)?(?:i\s+)?${CANT}\s+${OBJECT}\b`),
  // "Unfortunately I cannot do that." — bare refusal naming the request itself.
  new RegExp(String.raw`^${SORRY}\b[,.!:;—-]*\s*(?:but\s+)?(?:i\s+)?${CANT}\b[^.!?]{0,60}\b(?:that|this|your)\s+(?:request|task|prompt|content|text|passage|one)\b`),
  // "I cannot assist with that request." — no apology, object named.
  new RegExp(String.raw`^(?:i\s+)?${CANT}\s+${OBJECT}\b(?:\s+\w+){0,4}?\s+(?:that|this|your)\b`),
  // "As an AI language model, I cannot …" and its first-person variants.
  /^(?:as an ai\b|i(?:'m| am) (?:an|just an|only an) ai\b)/,
  // "I must decline to translate this."
  new RegExp(String.raw`^i\s+(?:must|have to|need to)\s+(?:decline|refuse)\b`),
  // "That request violates my guidelines."
  /^(?:that|this|your)\s+(?:request|content|prompt|text)\s+(?:violates|goes against|is against|conflicts with)\b/,
]

/**
 * Normalise a reply for matching: drop any markup the IDML/footnote paths add,
 * fold curly apostrophes and all whitespace, and lowercase. Markdown emphasis
 * and bullets are stripped so `**I'm sorry, but …**` still anchors. A LEADING
 * QUOTE IS KEPT deliberately: a quoted line is reported speech ("I'm sorry,
 * but I cannot help you.") — a real translation — and must not anchor.
 */
function normalizeReply(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[*\-•\s]+/, "")
    .toLowerCase()
}

/**
 * True when `text` is a model refusal rather than a translation. Callers treat
 * a `true` exactly like an empty completion: nothing is committed, the cell
 * keeps whatever it had, and the failure is surfaced to the user.
 */
export function isRefusalReply(text: string): boolean {
  const normalized = normalizeReply(text)
  if (!normalized) return false
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(normalized))
}

/** The message the editor shows on a refused draft (sibling of the AQU-685 empty-result copy). */
export const REFUSAL_ERROR_MESSAGE = "The model declined to translate this cell — nothing was saved"
