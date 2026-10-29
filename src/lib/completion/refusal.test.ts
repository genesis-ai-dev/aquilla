// AQU-2217 — the specification for `isRefusalReply`.
//
// A partner contributor's cell was left holding the literal text "I'm sorry,
// but I cannot assist with that request." because the draft paths committed
// any non-empty reply. This table is the contract for what counts as a
// refusal: the vendor boilerplate in, real translations — including ones that
// say "sorry" or carry refusal-shaped dialogue — out.

import { describe, it, expect } from "vitest"
import { isRefusalReply } from "./refusal"

const REFUSALS: [label: string, reply: string][] = [
  ["the reported OpenAI refusal", "I'm sorry, but I cannot assist with that request."],
  ["curly apostrophes", "I’m sorry, but I can’t assist with that request."],
  ["short form", "Sorry, I can't help with that."],
  ["no apology", "I cannot assist with that request."],
  ["unable-to form", "I am unable to assist with this request."],
  ["won't form", "I'm sorry, but I won't provide a translation of this text."],
  ["unfortunately", "Unfortunately, I cannot provide a translation for that request."],
  ["afraid", "I'm afraid I can't help with this one."],
  ["apologies", "My apologies, but I cannot complete that request."],
  ["as-an-AI", "As an AI language model, I cannot translate this text."],
  ["I'm an AI", "I'm an AI and cannot assist with that."],
  ["must decline", "I must decline to translate this passage."],
  ["policy statement", "That request violates my content guidelines."],
  ["markdown emphasis", "**I'm sorry, but I cannot assist with that request.**"],
  ["long explanation after the opener", "I'm sorry, but I cannot assist with that request. Translating this passage would require me to make claims about a religious text that I am not able to verify, and my guidelines do not permit it."],
  ["leading whitespace and newline", "\n  I'm sorry, but I cannot assist with that request.\n"],
]

const TRANSLATIONS: [label: string, reply: string][] = [
  ["a plain translation", "Une traduction du verset."],
  ["mentions sorry", "He was sorry for what he had done, and he wept."],
  ["sorry without a refusal verb", "I am sorry for your loss, my brother."],
  ["cannot without a request object", "I cannot go with you, for the way is long."],
  ["reported speech, quoted", "\"I'm sorry, but I cannot help you,\" the steward said."],
  ["reported speech, attributed first", "She said, \"I'm sorry, but I cannot help you.\""],
  ["unable in narrative", "They were unable to carry the load any further."],
  ["a verse about declining", "He declined the offer and turned away."],
  ["an English verse with 'I am unable'", "Then Isaac said, I am unable to see, for my eyes are dim."],
  ["USFM markup", "\\v 5 For our gospel came to you not only in word."],
  ["empty", ""],
  ["whitespace", "   \n "],
]

describe("isRefusalReply", () => {
  it.each(REFUSALS)("flags a refusal: %s", (_label, reply) => {
    expect(isRefusalReply(reply)).toBe(true)
  })

  it.each(TRANSLATIONS)("passes a real translation through: %s", (_label, reply) => {
    expect(isRefusalReply(reply)).toBe(false)
  })
})
