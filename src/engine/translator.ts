/**
 * Translation as a map operation (spec §4.3).
 *
 * A translator receives explicit, hashable inputs and returns proposed
 * outputs. Outputs are never trusted: every result is validated against the
 * source's tag structure before it becomes a fact. Because LLM inference is
 * not deterministic, reproducibility comes from *recording the output and its
 * provenance*, not from re-running the model.
 */
import { replaceTerm } from "../core/context.ts"
import { hashValue } from "../core/hash.ts"
import type { Provenance } from "../core/ledger.ts"
import type { PriorTranslation } from "../core/plan.ts"
import { parseTagged } from "../core/tagged.ts"

export interface TranslationJob {
  readonly logicalId: string
  readonly sourceLocale: string
  readonly targetLocale: string
  readonly sourceTagged: string
  readonly contextRevision: string
  readonly policyRevision: string
  readonly terms: ReadonlyArray<{ source: string; target: string; note?: string }>
  readonly rules: readonly string[]
  readonly prior: readonly PriorTranslation[]
  /** Neighbouring source text, for discourse context. */
  readonly before?: string
  readonly after?: string
  readonly docTitle?: string
}

export interface TranslationOutput {
  readonly logicalId: string
  readonly tagged: string
  readonly provenance: Provenance
}

export interface Translator {
  readonly id: string
  translate(jobs: readonly TranslationJob[]): Promise<TranslationOutput[]>
}

// ── Pseudo translator ───────────────────────────────────────────────────────

const ACCENTS: Record<string, string> = {
  a: "á", e: "é", i: "í", o: "ö", u: "ü", c: "ç", n: "ñ", y: "ý", s: "š", z: "ž",
  A: "Á", E: "É", I: "Í", O: "Ö", U: "Ü", C: "Ç", N: "Ñ", Y: "Ý", S: "Š", Z: "Ž",
}

/** Typical text expansion by target language, used to make layout tests realistic. */
const EXPANSION: Record<string, number> = { de: 1.3, fr: 1.2, es: 1.2, pt: 1.2, it: 1.15, ru: 1.15, nl: 1.25, ja: 0.6, zh: 0.55, ko: 0.8 }

/**
 * Deterministic pseudo-localisation. Same input → same output, so tests and
 * the demo are reproducible without network access. It honours glossary
 * terms (rendered verbatim and protected from accenting), keeps tags intact,
 * and expands text by a per-language factor.
 */
export class PseudoTranslator implements Translator {
  readonly id = "pseudo"
  async translate(jobs: readonly TranslationJob[]): Promise<TranslationOutput[]> {
    return jobs.map((job) => ({ logicalId: job.logicalId, tagged: pseudoTranslate(job), provenance: { translator: "pseudo", promptHash: hashValue(job) } }))
  }
}

export const pseudoTranslate = (job: TranslationJob): string => {
  const lang = job.targetLocale.split(/[-_]/)[0]!.toLowerCase()
  const factor = EXPANSION[lang] ?? 1.15
  const placeholders: string[] = []
  const protect = (s: string): string => {
    let out = s
    for (const t of [...job.terms].sort((a, b) => b.source.length - a.source.length)) {
      out = replaceTerm(out, t.source, `\u0001${placeholders.length}\u0002`)
      placeholders.push(t.target)
    }
    return out
  }
  let out = ""
  let textChars = 0
  for (const p of parseTagged(job.sourceTagged)) {
    if (p.kind === "open") out += `<g${p.id}>`
    else if (p.kind === "close") out += `</g${p.id}>`
    else if (p.kind === "token") out += `<x${p.id}/>`
    else {
      const prot = protect(p.text)
      const accented = prot.replace(/\u0001(\d+)\u0002|[A-Za-z]/g, (m, idx: string | undefined) => (idx !== undefined ? m : (ACCENTS[m] ?? m)))
      out += accented.replace(/\u0001(\d+)\u0002/g, (_m, idx: string) => placeholders[Number(idx)] ?? "")
      textChars += p.text.length
    }
  }
  // Expansion padding goes at the end of the last text, before any trailing closing tags.
  const pad = Math.round(textChars * (factor - 1))
  if (pad > 0 && textChars > 0) {
    const filler = " " + "·".repeat(Math.max(0, pad - 1))
    const m = /((?:<\/g\d+>)*)$/.exec(out)!
    out = out.slice(0, m.index).replace(/\s+$/, (ws) => filler + ws) + (/\s$/.test(out.slice(0, m.index)) ? "" : filler) + m[1]
  }
  return `⟦${lang}⟧ ${out}`.replace(/^⟦(\w+)⟧ (<g\d+>)/, "$2⟦$1⟧ ")
}

// ── Claude translator ───────────────────────────────────────────────────────

/**
 * Claude via the official SDK, with structured JSON output. Loaded lazily so
 * the functional core and the tests never need network access or a key.
 */
export class ClaudeTranslator implements Translator {
  readonly id: string
  constructor(
    private readonly options: { model?: string; effort?: "low" | "medium" | "high"; orgContext?: string; batchSize?: number } = {},
  ) {
    this.id = `claude:${options.model ?? "claude-opus-5-5"}`
  }

  async translate(jobs: readonly TranslationJob[]): Promise<TranslationOutput[]> {
    const out: TranslationOutput[] = []
    const size = this.options.batchSize ?? 25
    for (let i = 0; i < jobs.length; i += size) out.push(...(await this.batch(jobs.slice(i, i + size))))
    return out
  }

  private async batch(jobs: readonly TranslationJob[]): Promise<TranslationOutput[]> {
    if (jobs.length === 0) return []
    const { default: Anthropic } = await import("@anthropic-ai/sdk")
    const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod")
    const { z } = await import("zod")
    const model = this.options.model ?? "claude-opus-5-5"
    const client = new Anthropic()
    const Schema = z.object({ translations: z.array(z.object({ id: z.string(), text: z.string() })) })
    const first = jobs[0]!
    const system = buildSystemPrompt(first.sourceLocale, first.targetLocale, this.options.orgContext)
    const user = buildUserPrompt(jobs)
    const started = Date.now()
    const response = await client.messages.parse({
      model,
      max_tokens: 32000,
      system,
      output_config: { effort: this.options.effort ?? "medium", format: zodOutputFormat(Schema) },
      messages: [{ role: "user", content: user }],
    })
    if (response.stop_reason === "refusal") throw new Error("the model declined this batch")
    const parsed = response.parsed_output
    if (!parsed) throw new Error("the model returned no parseable translations")
    const byId = new Map(parsed.translations.map((t) => [t.id, t.text]))
    const promptHash = hashValue({ system, user, model })
    return jobs.flatMap((j, k) => {
      const text = byId.get(String(k + 1))
      return text === undefined ? [] : [{ logicalId: j.logicalId, tagged: text, provenance: { translator: "claude", model, promptHash, durationMs: Date.now() - started } }]
    })
  }
}

export const buildSystemPrompt = (sourceLocale: string, targetLocale: string, orgContext?: string): string =>
  [
    `You translate content from ${sourceLocale} to ${targetLocale} for publication.`,
    `The text uses inline tags: <gN>…</gN> marks a formatting run (bold, italic, link…) and <xN/> marks an inline object (variable, image, footnote marker…).`,
    `Keep every <xN/> exactly once. Wrap the translated words that correspond to each <gN> run in the same tag; runs may move to match ${targetLocale} word order. Do not invent tags.`,
    `Glossary terms are binding. Follow house rules. When a prior human translation is provided, treat it as authoritative: change only what the source change requires and keep the human's wording elsewhere.`,
    `Preserve leading/trailing whitespace, tabs and numbers. Translate everything else; never leave source-language words untranslated unless they are names or the glossary says so.`,
    ...(orgContext ? [`Organisation context:\n${orgContext}`] : []),
  ].join("\n")

export const buildUserPrompt = (jobs: readonly TranslationJob[]): string => {
  const terms = new Map<string, string>()
  for (const j of jobs) for (const t of j.terms) terms.set(t.source, t.target + (t.note ? ` (${t.note})` : ""))
  const rules = [...new Set(jobs.flatMap((j) => j.rules))]
  const parts: string[] = []
  if (terms.size) parts.push(`Glossary:\n${[...terms].map(([s, t]) => `- ${s} → ${t}`).join("\n")}`)
  if (rules.length) parts.push(`House rules:\n${rules.map((r) => `- ${r}`).join("\n")}`)
  parts.push(
    `Translate each item. Return {"translations":[{"id":"1","text":"…"},…]} with one entry per item.\n\n` +
      jobs
        .map((j, k) => {
          const lines = [`### Item ${k + 1}`]
          if (j.before) lines.push(`(preceding text: ${j.before.slice(0, 300)})`)
          for (const p of j.prior) {
            lines.push(`Previous ${p.authority === "agent" ? "machine" : "human-approved"} translation of the earlier source:\n  source: ${p.source}\n  target: ${p.target}`)
          }
          lines.push(`Source: ${j.sourceTagged}`)
          return lines.join("\n")
        })
        .join("\n\n"),
  )
  return parts.join("\n\n")
}

export const makeTranslator = (spec: string | undefined, orgContext?: string): Translator => {
  if (!spec || spec === "pseudo") return new PseudoTranslator()
  if (spec === "claude" || spec.startsWith("claude:")) {
    const model = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : undefined
    return new ClaudeTranslator({ ...(model ? { model } : {}), ...(orgContext ? { orgContext } : {}) })
  }
  throw new Error(`unknown translator '${spec}' (use 'pseudo' or 'claude[:model]')`)
}
