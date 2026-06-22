/**
 * render — turn the deterministic composition into a frame sequence.
 *
 * Loads compose.html in headless Chromium, injects a persona's brief (and any
 * real app stills), then for each frame sets window.__seek(frame/fps) and
 * screenshots. Because the composition is a pure function of time, this is a
 * seek-and-shoot: no realtime playback, no dropped frames, identical output
 * every run regardless of host speed.
 */
import { chromium } from "@playwright/test"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadConfig } from "./promo.config"
import type { PromoConfig } from "./types"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const COMPOSE = path.join(__dirname, "compose.html")
const OUT = path.resolve(__dirname, "../../e2e/recordings/output/promo")
const FRAME_DIR = path.join(OUT, "frames")
const APP_DIR = path.join(OUT, "app") // optional real app stills from capture-app.ts

/** Collect captured app stills (if any) as file:// URLs, in order. */
function appFrameUrls(): string[] {
  if (!existsSync(APP_DIR)) return []
  return readdirSync(APP_DIR)
    .filter((f) => f.endsWith(".png") || f.endsWith(".jpg"))
    .sort()
    .map((f) => pathToFileURL(path.join(APP_DIR, f)).href)
}

export async function renderFrames(config?: PromoConfig): Promise<{ frameDir: string; count: number }> {
  const promo = config ?? loadConfig()
  mkdirSync(FRAME_DIR, { recursive: true })
  // clean stale frames so a shorter render can't leave a longer tail behind
  for (const f of readdirSync(FRAME_DIR)) if (f.endsWith(".png")) rmSync(path.join(FRAME_DIR, f))

  const appFrames = appFrameUrls()
  console.log(
    `[promo:render] persona "${promo.persona}" · ${appFrames.length ? `${appFrames.length} real app stills` : "stylized panel"}; ` +
      `${promo.durationSec}s @ ${promo.fps}fps = ${promo.durationSec * promo.fps} frames`,
  )

  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: promo.width, height: promo.height },
    deviceScaleFactor: 1,
  })
  await page.addInitScript(
    ([promo, frames]) => {
      ;(globalThis as unknown as { __PROMO: unknown }).__PROMO = promo
      ;(globalThis as unknown as { __APP_FRAMES: unknown }).__APP_FRAMES = frames
    },
    [promo, appFrames] as const,
  )
  await page.goto(pathToFileURL(COMPOSE).href)
  await page.waitForFunction(() => (globalThis as unknown as { __ready?: boolean }).__ready === true)
  // give the real stills a moment to decode before the first shot
  if (appFrames.length) await page.waitForTimeout(300)

  const total = Math.round(promo.durationSec * promo.fps)
  for (let i = 0; i < total; i++) {
    const t = i / promo.fps
    await page.evaluate((tt) => (globalThis as unknown as { __seek: (t: number) => void }).__seek(tt), t)
    await page.screenshot({
      path: path.join(FRAME_DIR, `f${String(i).padStart(5, "0")}.png`),
      clip: { x: 0, y: 0, width: promo.width, height: promo.height },
    })
    if (i % 30 === 0) process.stdout.write(`\r[promo:render] frame ${i}/${total}`)
  }
  process.stdout.write(`\r[promo:render] ${total}/${total} frames done\n`)
  await browser.close()
  return { frameDir: FRAME_DIR, count: total }
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  renderFrames().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
