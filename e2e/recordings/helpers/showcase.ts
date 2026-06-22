import { type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.resolve(__dirname, "../output")

export interface ChapterMark {
  /** ms since the take started */
  t: number
  title: string
  subtitle?: string
}
export interface CaptionMark {
  t: number
  text: string
}

export interface ShowcaseOpts {
  /** Persona slug from docs/distribution/PERSONAS.md, e.g. "p1-field-translator". */
  persona: string
  /** The feature/value the take showcases, e.g. "consistency-guardrails". */
  feature: string
  /** Human title for the assembled video. */
  title: string
  /** One-line value proposition rendered as the closing card. */
  cta: string
}

/**
 * Showcase driver — wraps a Playwright Page to produce *legible marketing
 * footage* of the real app, plus a machine-readable storyboard that the
 * assembler (scripts/assemble-showcase.ts) turns into announce / docs / market
 * cuts with title cards and (optionally) ElevenLabs voiceover.
 *
 * What it does:
 *  - `chapter()` paints an on-screen lower-third so the recording is
 *    self-narrating even before any VO is added, and logs a chapter mark.
 *  - `caption()` shows a subtitle line — this doubles as the VO script,
 *    aligned to a timestamp so narration lands on the right action.
 *  - `beat()` is a deliberate pause so a human viewer can register what just
 *    happened (slowMo handles per-action pacing; beats handle "let it land").
 *  - `save()` writes the storyboard JSON next to the recorded video.
 *
 * Everything it overlays is removed from the DOM before `save()` so it never
 * interferes with assertions and only ever lives inside the video frame.
 */
export class Showcase {
  private readonly page: Page
  private readonly opts: ShowcaseOpts
  private readonly startedAt = Date.now()
  private readonly chapters: ChapterMark[] = []
  private readonly captions: CaptionMark[] = []
  private overlayReady = false

  constructor(page: Page, opts: ShowcaseOpts) {
    this.page = page
    this.opts = opts
  }

  private now(): number {
    return Date.now() - this.startedAt
  }

  /** Inject the caption/lower-third overlay layer + a persistent brand bug. */
  private async ensureOverlay(): Promise<void> {
    if (this.overlayReady) return
    await this.page.addStyleTag({
      content: `
        #__showcase_layer{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Inter,system-ui,sans-serif}
        #__showcase_chapter{position:absolute;left:48px;bottom:64px;max-width:62%;
          background:linear-gradient(90deg,rgba(12,16,24,.92),rgba(12,16,24,.72));
          color:#f6f8fc;padding:18px 24px;border-radius:14px;border-left:4px solid #6aa9ff;
          box-shadow:0 12px 40px rgba(0,0,0,.45);opacity:0;transform:translateY(12px);
          transition:opacity .35s ease,transform .35s ease}
        #__showcase_chapter.on{opacity:1;transform:translateY(0)}
        #__showcase_chapter .t{font-size:26px;font-weight:700;letter-spacing:-.01em}
        #__showcase_chapter .s{font-size:17px;opacity:.82;margin-top:4px;font-weight:500}
        #__showcase_caption{position:absolute;left:50%;bottom:32px;transform:translateX(-50%);
          max-width:80%;text-align:center;background:rgba(12,16,24,.82);color:#fff;
          padding:10px 20px;border-radius:999px;font-size:18px;font-weight:600;
          opacity:0;transition:opacity .25s ease}
        #__showcase_caption.on{opacity:1}
        #__showcase_bug{position:absolute;right:28px;top:24px;color:#fff;opacity:.85;
          font-size:15px;font-weight:700;letter-spacing:.04em;
          text-shadow:0 1px 6px rgba(0,0,0,.6)}
      `,
    })
    await this.page.evaluate(() => {
      const layer = document.createElement("div")
      layer.id = "__showcase_layer"
      layer.innerHTML = `
        <div id="__showcase_bug">AQUILLA</div>
        <div id="__showcase_chapter"><div class="t"></div><div class="s"></div></div>
        <div id="__showcase_caption"></div>`
      document.body.appendChild(layer)
    })
    this.overlayReady = true
  }

  /** Title-card / lower-third moment. Stays on screen until the next chapter. */
  async chapter(title: string, subtitle?: string): Promise<void> {
    await this.ensureOverlay()
    this.chapters.push({ t: this.now(), title, subtitle })
    await this.page.evaluate(
      ([t, s]) => {
        const el = document.getElementById("__showcase_chapter")
        if (!el) return
        ;(el.querySelector(".t") as HTMLElement).textContent = t
        ;(el.querySelector(".s") as HTMLElement).textContent = s ?? ""
        el.classList.add("on")
      },
      [title, subtitle ?? ""],
    )
    await this.page.waitForTimeout(900)
  }

  /** Subtitle line — doubles as the timestamped VO script. */
  async caption(text: string): Promise<void> {
    await this.ensureOverlay()
    this.captions.push({ t: this.now(), text })
    await this.page.evaluate((tx) => {
      const el = document.getElementById("__showcase_caption")
      if (!el) return
      el.textContent = tx
      el.classList.add("on")
    }, text)
    // Hold long enough to read (~3 wps + base).
    await this.page.waitForTimeout(Math.min(5000, 700 + text.length * 45))
    await this.page.evaluate(() => document.getElementById("__showcase_caption")?.classList.remove("on"))
  }

  /** Let the last action land on screen. */
  async beat(ms = 800): Promise<void> {
    await this.page.waitForTimeout(ms)
  }

  /** Strip the overlay and persist the storyboard contract for assembly. */
  async save(): Promise<string> {
    if (this.overlayReady) {
      await this.page.evaluate(() => document.getElementById("__showcase_layer")?.remove())
    }
    mkdirSync(OUTPUT_DIR, { recursive: true })
    const slug = `${this.opts.persona}__${this.opts.feature}`
    const file = path.join(OUTPUT_DIR, `${slug}.storyboard.json`)
    writeFileSync(
      file,
      JSON.stringify(
        {
          slug,
          persona: this.opts.persona,
          feature: this.opts.feature,
          title: this.opts.title,
          cta: this.opts.cta,
          durationMs: this.now(),
          chapters: this.chapters,
          captions: this.captions,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
    return file
  }
}
