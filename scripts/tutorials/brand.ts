/**
 * How a tutorial video looks: Aquilla's marketing identity (the ink base and
 * azure accent of aquilla-marketing/src/styles/marketing-theme.css, which the
 * help site's src/styles/aquilla.css copies too), drawn round the app.
 *
 * The oklch tokens are given here as sRGB hex because ffmpeg takes hex.
 */
export const BRAND = {
  name: "Aquilla",
  tagline: "Translators, lifted.",
  helpSite: "help.aquilla.app",
  /** --aq-ink, oklch(0.155 0.016 264): the page. */
  ink: "#090c13",
  /** --aq-ink-2 and --aq-ink-3: the panel behind the app. */
  ink2: "#121720",
  ink3: "#1b202b",
  /** --aq-text and --aq-dim. */
  text: "#f1f3f9",
  dim: "#c0c4cc",
  /** The azure accent, oklch(0.74 0.14 245), and its deeper and softer steps. */
  azure: "#54b3fd",
  azureDeep: "#0f74c5",
  azureSoft: "#92d6ff",
  /** The app's mark and its body face, from this repository. */
  logo: "public/favicon-aquilla.svg",
  font: "node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
} as const

/**
 * The frame's version. Raise it when a change to the frame, the cards or the
 * layout should film every video again; a change that only makes new films
 * look better leaves it, and each video picks it up when it is next filmed.
 */
export const FRAME = 1

/** The finished video, 16:9. */
export const CANVAS = { width: 1920, height: 1080, fps: 30 } as const

/** The recording (e2e/config/playwright.config.recordings.ts films 1280x800)
 * sits in a window under the title, 1.1 times its size. */
export const WINDOW = { x: 256, y: 152, width: 1408, height: 880, radius: 18 } as const

export const INTRO_MS = 2000
export const OUTRO_MS = 2600
export const FADE_MS = 300
