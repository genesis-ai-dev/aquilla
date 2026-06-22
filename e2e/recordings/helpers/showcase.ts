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
  /**
   * Editorial profile, recorded in the storyboard so the assembler can pick
   * pacing + framing:
   *  - "doc"   → clarity-first: programmatic cursor, zoom-into-click, slow
   *               captioned steps. The default when you use cursor()/zoom().
   *  - "promo" → amaze-first: fast cuts, big claims (the trailer pipeline).
   * Defaults to "promo" to preserve existing takes.
   */
  mode?: "doc" | "promo"
}

/** A cursor/zoom target: a CSS selector (resolved to its centre) or a point. */
export type Target = string | { x: number; y: number }

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
  private zoomed = false

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
        #__showcase_cursor{position:absolute;left:0;top:0;width:30px;height:30px;
          transform:translate(-120px,-120px);
          transition:transform .7s cubic-bezier(.22,.61,.36,1);
          will-change:transform;filter:drop-shadow(0 3px 7px rgba(0,0,0,.5))}
        #__showcase_ring{position:absolute;left:0;top:0;width:26px;height:26px;border-radius:999px;
          border:3px solid #6aa9ff;opacity:0;
          transform:translate(-50%,-50%) scale(.3)}
        #__showcase_ring.pulse{animation:__sc_ring .55s ease-out}
        @keyframes __sc_ring{
          0%{opacity:.85;transform:translate(-50%,-50%) scale(.3)}
          100%{opacity:0;transform:translate(-50%,-50%) scale(2.6)}}
      `,
    })
    await this.page.evaluate(() => {
      const layer = document.createElement("div")
      layer.id = "__showcase_layer"
      // Cursor tip sits at the element's translate origin (~3,3 inside the SVG).
      layer.innerHTML = `
        <div id="__showcase_bug">AQUILLA</div>
        <div id="__showcase_ring"></div>
        <div id="__showcase_cursor">
          <svg viewBox="0 0 24 24" width="30" height="30">
            <path d="M3 2 L3 20 L8 15 L11.5 22 L14.5 20.5 L11 13.5 L18 13.5 Z"
              fill="#fff" stroke="#0c1018" stroke-width="1.4" stroke-linejoin="round"/>
          </svg>
        </div>
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

  // ───────────────────────── documentation toolkit ─────────────────────────
  // A programmatic cursor + zoom-into-click so doc takes read clearly: the
  // viewer's eye is led to the exact control, the click is punctuated, and the
  // region of interest is magnified — all as overlay/visual-only transforms
  // that never touch assertions and are stripped in save().

  /**
   * Resolve a target string to a CSS selector. A leading "@" addresses a
   * readable showcase label, i.e. `@sidebar.file` → `[data-showcase="sidebar.file"]`
   * (see docs/distribution/SHOWCASE-LABELS.md). Anything else is a raw selector.
   * This is what lets a doc script read like directions — `click("@sidebar.file")`
   * lands on a real, addressable list item rather than a guessed coordinate.
   */
  private toSelector(target: string): string {
    return target.startsWith("@") ? `[data-showcase="${target.slice(1)}"]` : target
  }

  /** Centre of a selector (Playwright box, so it reflects any active zoom). */
  private async resolvePoint(target: Target): Promise<{ x: number; y: number }> {
    if (typeof target !== "string") return target
    const box = await this.page.locator(this.toSelector(target)).first().boundingBox()
    if (!box) throw new Error(`showcase: cursor target not visible: ${target}`)
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  /** Glide the on-screen cursor to a target. Lower-level; prefer point()/click(). */
  async cursorTo(target: Target, { ms = 700 }: { ms?: number } = {}): Promise<void> {
    await this.ensureOverlay()
    const { x, y } = await this.resolvePoint(target)
    await this.page.evaluate(
      ([x, y, ms]) => {
        const c = document.getElementById("__showcase_cursor")
        if (!c) return
        c.style.transition = `transform ${ms}ms cubic-bezier(.22,.61,.36,1)`
        c.style.transform = `translate(${x - 3}px, ${y - 3}px)`
      },
      [x, y, ms] as const,
    )
    await this.page.waitForTimeout(ms + 120)
  }

  /** Pulse a click ripple at a screen point. */
  private async ripple(pt: { x: number; y: number }): Promise<void> {
    await this.page.evaluate(
      ([x, y]) => {
        const r = document.getElementById("__showcase_ring")
        if (!r) return
        r.style.left = `${x}px`
        r.style.top = `${y}px`
        r.classList.remove("pulse")
        void r.offsetWidth // force reflow so the animation re-fires
        r.classList.add("pulse")
      },
      [pt.x, pt.y] as const,
    )
    await this.page.waitForTimeout(560)
  }

  /** Lead the eye: glide the cursor to a target and pulse a ring, no click. */
  async point(target: Target, { ms = 700 }: { ms?: number } = {}): Promise<void> {
    await this.cursorTo(target, { ms })
    await this.ripple(await this.resolvePoint(target))
  }

  /** Glide to a target, punctuate with a ripple, then perform the real click. */
  async click(target: Target, { ms = 700, real = true }: { ms?: number; real?: boolean } = {}): Promise<void> {
    const pt = await this.resolvePoint(target)
    await this.cursorTo(pt, { ms })
    await this.ripple(pt)
    if (!real) return
    if (typeof target === "string") await this.page.locator(this.toSelector(target)).first().click()
    else await this.page.mouse.click(pt.x, pt.y)
  }

  /** Magnify the app around a target (visual emphasis on #root only — the
   * overlay stays crisp). Always zooms from the unzoomed state for correct
   * transform-origin math. */
  async zoomTo(
    target: Target,
    { scale = 1.6, ms = 650 }: { scale?: number; ms?: number } = {},
  ): Promise<void> {
    await this.ensureOverlay()
    if (this.zoomed) await this.zoomReset({ ms: 280 })
    const pt = await this.resolvePoint(target)
    await this.page.evaluate(
      ([x, y, scale, ms]) => {
        const root = document.getElementById("root")
        if (!root) return
        const rb = root.getBoundingClientRect()
        root.style.transition = `transform ${ms}ms cubic-bezier(.22,.61,.36,1)`
        root.style.transformOrigin = `${x - rb.left}px ${y - rb.top}px`
        root.style.transform = `scale(${scale})`
      },
      [pt.x, pt.y, scale, ms] as const,
    )
    this.zoomed = true
    await this.page.waitForTimeout(ms + 120)
  }

  /** Ease the app back to 1×. */
  async zoomReset({ ms = 520 }: { ms?: number } = {}): Promise<void> {
    if (!this.zoomed) return
    await this.page.evaluate((ms) => {
      const root = document.getElementById("root")
      if (!root) return
      root.style.transition = `transform ${ms}ms cubic-bezier(.22,.61,.36,1)`
      root.style.transform = "none"
    }, ms)
    this.zoomed = false
    await this.page.waitForTimeout(ms + 80)
  }

  /** Strip the overlay and persist the storyboard contract for assembly.
   *
   * @param verified whether the take's value/money moment actually rendered
   *   (asserted by the spec). When false the storyboard is a partial cut —
   *   the assembler/human must not ship it as a value claim. */
  async save(verified = true): Promise<string> {
    // Clear any zoom transform so the DOM is pristine for post-take assertions.
    await this.page
      .evaluate(() => {
        const root = document.getElementById("root")
        if (root) {
          root.style.transform = ""
          root.style.transformOrigin = ""
          root.style.transition = ""
        }
      })
      .catch(() => {})
    this.zoomed = false
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
          mode: this.opts.mode ?? "promo",
          verified,
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
