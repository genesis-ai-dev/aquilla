/**
 * promo.config — the single source of truth for the trailer's timing.
 *
 * Both the audio synth (synth-audio.ts) and the visual composition
 * (compose.html, via render.ts) read this, so beats, scene cuts, and captions
 * are guaranteed to line up. Everything downstream is a pure function of time
 * over this grid — change a number here and re-run `npm run promo`.
 */
export interface PromoScene {
  /** start time, seconds */
  t: number
  /** scene id, drives the composition's layout */
  id: "cold-open" | "reveal" | "showcase" | "proof" | "cta"
  /** big line */
  title: string
  /** supporting line */
  subtitle?: string
}

export interface PromoConfig {
  durationSec: number
  fps: number
  width: number
  height: number
  brand: string
  scenes: PromoScene[]
  /** Beat grid shared with the score. */
  beats: { t: number; kind: "thump" | "swell" | "impact" }[]
}

export const PROMO: PromoConfig = {
  durationSec: 18,
  fps: 30,
  width: 1920,
  height: 1080,
  brand: "AQUILLA",
  scenes: [
    { t: 0.0, id: "cold-open", title: "Every verse.", subtitle: "Every language." },
    { t: 3.0, id: "reveal", title: "One living workspace.", subtitle: "Source and target, side by side." },
    { t: 6.5, id: "showcase", title: "Real projects.", subtitle: "Populated the moment you land." },
    { t: 11.0, id: "proof", title: "Validated, in sync.", subtitle: "Your team's work, alive on screen." },
    { t: 14.5, id: "cta", title: "Aquilla", subtitle: "Translation, together." },
  ],
  beats: [
    { t: 0.4, kind: "thump" },
    { t: 1.9, kind: "thump" },
    { t: 3.0, kind: "swell" },
    { t: 4.4, kind: "thump" },
    { t: 6.5, kind: "thump" },
    { t: 8.0, kind: "thump" },
    { t: 9.6, kind: "thump" },
    { t: 11.0, kind: "swell" },
    { t: 12.6, kind: "thump" },
    { t: 14.5, kind: "impact" },
  ],
}
