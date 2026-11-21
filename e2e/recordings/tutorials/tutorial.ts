import { test, type Locator, type Page } from "@playwright/test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Showcase, type Target } from "../helpers/showcase"
import { tutorialById, type TutorialDef, type TutorialId } from "./catalog"
import { hashText, lookOf, steadyScreen } from "./look"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** Where scripts/tutorials/voice.ts keeps each line's recording. */
const VOICE_INDEX = path.resolve(__dirname, "../../../.video-staging/tutorials/voice/voice.json")

/** Mirrors M_PROJECT_ID in auth-worker/src/routes/marketing-seed.ts. */
const DEMO_PROJECT = "demo-john"

/** Quiet after a line, so two lines never run together. */
const BREATH_MS = 350

export interface LineMark {
  key: string
  text: string
  /** ms since the take started when the line begins. */
  t: number
  /** How long the take held for it: its voice's length, or a reading-speed
   * guess when the line has no voice yet. */
  ms: number
  voiced: boolean
}

interface VoiceIndex {
  lines: Record<string, { file: string; durationMs: number }>
}

function loadVoice(): VoiceIndex["lines"] {
  if (!existsSync(VOICE_INDEX)) return {}
  return (JSON.parse(readFileSync(VOICE_INDEX, "utf-8")) as VoiceIndex).lines
}

/** About 2.6 words a second, the pace of the voice, for a line not said yet. */
export function guessSpokenMs(text: string): number {
  const words = text.trim().split(/\s+/).length
  return Math.round(600 + (words / 2.6) * 1000)
}

/**
 * One tutorial video's take. `say()` is the script: each line is held for as
 * long as its voice lasts, so what is on screen is what is being said, and
 * the screen is read as text for the video's look. The camera and the cursor
 * are the Showcase's (`show`); the app is driven with the e2e page objects, so
 * a tutorial clicks what a test clicks.
 */
export class Tutorial {
  readonly page: Page
  readonly show: Showcase
  readonly def: TutorialDef
  private readonly voice = loadVoice()
  private readonly lines: LineMark[] = []
  private readonly screens: string[] = []
  private readonly startedAt = Date.now()

  constructor(page: Page, def: TutorialDef) {
    this.page = page
    this.def = def
    this.show = new Showcase(page, {
      persona: "tutorial",
      feature: def.id,
      title: def.title,
      cta: "Aquilla. Translators, lifted.",
      mode: "doc",
      overlay: "pointer",
    })
  }

  /** Say one of the video's lines (catalog.ts) and hold while it is said. */
  async say(key: string): Promise<void> {
    const text = this.def.lines[key]
    if (!text) throw new Error(`tutorial ${this.def.id}: no line "${key}" in catalog.ts`)
    const spoken = this.voice[hashText(text)]
    const ms = (spoken?.durationMs ?? guessSpokenMs(text)) + BREATH_MS
    this.screens.push(steadyScreen(await this.page.locator("#root").ariaSnapshot()))
    this.lines.push({ key, text, t: Date.now() - this.startedAt, ms, voiced: Boolean(spoken) })
    await this.show.caption(text, { holdMs: ms })
  }

  /** Lead the eye to something without clicking it. */
  async point(target: Target | Locator): Promise<void> {
    await this.show.point(target)
  }

  /** Move in on something, hold while `during` runs, and move back out. */
  async closeUp(target: Target | Locator, during: () => Promise<void>, scale = 1.5): Promise<void> {
    await this.show.zoomTo(target, { scale })
    try {
      await during()
    } finally {
      await this.show.zoomReset()
    }
  }

  /** @param videoPath where Playwright leaves this take's recording. */
  async finish(verified: boolean, preludeMs: number, videoPath: string): Promise<void> {
    const said = new Set(this.lines.map((line) => line.key))
    const unsaid = Object.keys(this.def.lines).filter((key) => !said.has(key))
    await this.show.save(verified && unsaid.length === 0, {
      tutorial: {
        id: this.def.id,
        audience: this.def.audience,
        // The recording starts when the page opens; the take starts after the
        // sign-in. The composer cuts this much off the front.
        preludeMs,
        // Where Playwright writes this take's recording, from the output folder.
        video: path.relative(path.resolve(__dirname, "../output"), videoPath),
        lines: this.lines,
        unsaid,
        look: lookOf(this.screens),
        voiced: this.lines.length > 0 && this.lines.every((line) => line.voiced),
      },
    })
    // Each line's screen as the look read it, beside the storyboard: when a
    // look changes, a diff of this file between two runs says what changed.
    writeFileSync(
      path.resolve(__dirname, `../output/tutorial__${this.def.id}.screens.txt`),
      this.lines.map((line, index) => `=== ${line.key} ===\n${this.screens[index]}`).join("\n\n") + "\n",
    )
    // Only when the body finished: its own error says more than this one.
    if (verified && unsaid.length > 0) {
      throw new Error(`tutorial ${this.def.id}: never said ${unsaid.join(", ")}. Say every line in catalog.ts or remove it.`)
    }
  }
}

/**
 * Define a tutorial video. The body drives the app and says the video's
 * lines; it must end having shown what the video promises, with an `expect`.
 *
 * Unlike the older showcase takes, a tutorial that cannot finish fails: a
 * video that stops half way is not published, and the last good film stays up.
 */
export function tutorial(id: TutorialId, body: (t: Tutorial) => Promise<void>): void {
  const def = tutorialById(id)
  test(`Tutorial · ${def.title}`, async ({ page, baseURL }, testInfo) => {
    const pageOpenedAt = Date.now()
    test.setTimeout(180_000)

    // The curated demo project, seeded again at each sign-in
    // (auth-worker/src/routes/marketing-seed.ts), so every video starts from
    // the same six verses whatever ran before it.
    await page.context().addCookies([{ name: "aq_hint", value: "1", url: baseURL ?? "http://127.0.0.1:6173" }])
    await page.goto("/__marketing/login")
    await page.waitForURL(new RegExp(`/project/${DEMO_PROJECT}`), { timeout: 45_000 })
    await page.locator('[data-showcase="editor.source"]').first().waitFor({ state: "visible", timeout: 30_000 })

    const t = new Tutorial(page, def)
    const preludeMs = Date.now() - pageOpenedAt
    let verified = false
    try {
      await body(t)
      verified = true
    } finally {
      // Playwright moves the recording here when the page closes.
      await t.finish(verified, preludeMs, testInfo.outputPath("video.webm"))
    }
  })
}
