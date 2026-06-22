/**
 * promo.config — load a persona's creative brief into a render-ready config.
 *
 * Each persona's trailer is driven by a brief (scripts/promo/briefs/
 * <persona>.brief.json) authored by the sub-agent creative process (see
 * docs/distribution/PROMO-CREATIVE-PROCESS.md). This module resolves which
 * brief to render and layers in the global frame/brand constants. Pick a
 * persona with `PROMO_PERSONA=<slug>` (env) or the build's --persona flag;
 * falls back to a generic brief so the pipeline always produces something.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { PromoBrief, PromoConfig } from "./types"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BRIEFS_DIR = path.join(__dirname, "briefs")

// Global, persona-independent constants.
const FRAME = { width: 1920, height: 1080, brand: "AQUILLA" }

/** Generic fallback brief (used when no persona brief is found). */
const DEFAULT_BRIEF: PromoBrief = {
  persona: "default",
  personaLabel: "Aquilla",
  emotionalThroughline: "The work you carry can finally feel light.",
  mood: "build",
  durationSec: 18,
  fps: 30,
  scenes: [
    { t: 0.0, id: "cold-open", title: "Every verse.", subtitle: "Every language." },
    { t: 3.0, id: "reveal", title: "One living workspace.", subtitle: "Source and target, side by side." },
    { t: 6.5, id: "showcase", title: "Real projects.", subtitle: "Open, and the work is already there." },
    { t: 11.0, id: "proof", title: "Validated, in sync.", subtitle: "Your team's work, alive on screen." },
    { t: 14.5, id: "cta", title: "Aquilla", subtitle: "Translation, together." },
  ],
  beats: [
    { t: 0.4, kind: "thump" }, { t: 1.9, kind: "thump" }, { t: 3.0, kind: "swell" },
    { t: 4.4, kind: "thump" }, { t: 6.5, kind: "thump" }, { t: 8.0, kind: "thump" },
    { t: 9.6, kind: "thump" }, { t: 11.0, kind: "swell" }, { t: 12.6, kind: "thump" },
    { t: 14.5, kind: "impact" },
  ],
}

function readBrief(slug: string): PromoBrief | null {
  const file = path.join(BRIEFS_DIR, `${slug}.brief.json`)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, "utf8")) as PromoBrief
}

/** Resolve the persona to render: explicit arg → env → first brief on disk → default. */
export function resolvePersona(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.PROMO_PERSONA) return process.env.PROMO_PERSONA
  if (existsSync(BRIEFS_DIR)) {
    const first = readdirSync(BRIEFS_DIR).find((f) => f.endsWith(".brief.json"))
    if (first) return first.replace(/\.brief\.json$/, "")
  }
  return "default"
}

/** Load the render-ready config for a persona. */
export function loadConfig(explicit?: string): PromoConfig {
  const slug = resolvePersona(explicit)
  const brief = readBrief(slug) ?? DEFAULT_BRIEF
  return { ...brief, ...FRAME }
}

/** Eagerly-resolved config for the current persona (back-compat for importers). */
export const PROMO: PromoConfig = loadConfig()
