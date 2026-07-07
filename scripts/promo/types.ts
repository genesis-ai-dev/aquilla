/**
 * Promo trailer types — the contract between the *creative* layer (persona
 * briefs, authored by the sub-agent process in docs/distribution/
 * PROMO-CREATIVE-PROCESS.md) and the *render* layer (compose.html + synth).
 *
 * A brief is the unit of creativity: one persona, one emotional throughline,
 * the scene copy + timing + musical mood that carry it. Everything visual and
 * sonic downstream is a pure function of the brief over time.
 */
import type { Mood } from "./synth-audio"

/** The five structural slots the composition knows how to stage. The brief
 *  supplies persona-specific copy for each; the layout is shared. */
export type SceneId = "cold-open" | "reveal" | "showcase" | "proof" | "cta"

export interface PromoScene {
  /** start time, seconds */
  t: number
  id: SceneId
  /** the big line */
  title: string
  /** the supporting line */
  subtitle?: string
}

export interface PromoBeat {
  t: number
  kind: "thump" | "swell" | "impact"
}

/**
 * A persona-targeted creative brief. This is what a creative-director
 * sub-agent produces (as JSON in scripts/promo/briefs/<persona>.brief.json),
 * and the only thing that changes between one persona's trailer and another's.
 */
export interface PromoBrief {
  /** persona slug from docs/distribution/PERSONAS.md, e.g. "p5-org-admin" */
  persona: string
  /** human label, for filenames + the storyboard */
  personaLabel: string
  /** one sentence: the feeling arc this trailer must land (NOT shown on screen) */
  emotionalThroughline: string
  /** musical character — see synth-audio Mood */
  mood: Mood
  durationSec: number
  fps: number
  scenes: PromoScene[]
  beats: PromoBeat[]
}

/** Render-ready config = a brief + the global frame/brand constants. */
export interface PromoConfig extends PromoBrief {
  width: number
  height: number
  brand: string
}
