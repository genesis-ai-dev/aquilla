import { complete } from "./completion-service"
import type { CompletionSettings } from "@/lib/parsers/types"

export const BACKTRANSLATION_SYSTEM_PROMPT = `You are a backtranslation assistant. You will be given text in {targetLanguage} that is a translation. Your job is to provide a word-for-word, literal translation of that text BACK into {sourceLanguage}.

A backtranslation preserves the exact words and structure of the translated text, even if it sounds unnatural. For example, if the translation says "house of him", the backtranslation should say "house of him" — not "his house". This shows exactly what the translation says at a word level.

The purpose is verification: translators use backtranslations to confirm their translation conveys the intended meaning and doesn't drift.

Return ONLY the backtranslation text. No explanations, no markdown, no notes.`

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

interface BuildOptions {
  sourceLanguage: string
  targetLanguage: string
  targetText: string
  examples: { target: string; backtranslation: string }[]
}

export function buildBacktranslationPrompt(options: BuildOptions): ChatMessage[] {
  const systemContent = BACKTRANSLATION_SYSTEM_PROMPT
    .replace(/\{sourceLanguage\}/g, options.sourceLanguage)
    .replace(/\{targetLanguage\}/g, options.targetLanguage)

  let userContent = ""
  for (const ex of options.examples) {
    userContent += `Text: ${ex.target}\nBacktranslation: ${ex.backtranslation}\n\n`
  }
  userContent += `Text: ${options.targetText}\nBacktranslation:`

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent.trim() },
  ]
}

export interface GenerateBacktranslationOptions extends BuildOptions {
  settings: CompletionSettings
  onChunk?: (text: string) => void
}

export async function generateBacktranslation(options: GenerateBacktranslationOptions): Promise<string> {
  const messages = buildBacktranslationPrompt({
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    targetText: options.targetText,
    examples: options.examples,
  })

  return complete({
    endpoint: options.settings.endpoint,
    model: options.settings.model,
    messages,
    maxTokens: options.settings.maxTokens,
    temperature: 0.1,
    stream: Boolean(options.onChunk),
    onChunk: options.onChunk,
  })
}
