/**
 * The still parts of a tutorial video, drawn by the browser so they use the
 * app's own typeface and mark: the frame the app sits in (title on top, a
 * see-through window for the recording), the opening card and the closing card.
 */
import { chromium } from "@playwright/test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { BRAND, CANVAS, WINDOW } from "./brand"

export interface CardPaths {
  frame: string
  intro: string
  outro: string
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function page(repoRoot: string, body: string, extraCss = ""): string {
  const font = readFileSync(path.join(repoRoot, BRAND.font)).toString("base64")
  const logo = readFileSync(path.join(repoRoot, BRAND.logo)).toString("base64")
  return `<!doctype html><meta charset="utf-8"><style>
    @font-face{font-family:Geist;font-weight:100 900;src:url(data:font/woff2;base64,${font}) format("woff2")}
    *{box-sizing:border-box;margin:0}
    html,body{width:${CANVAS.width}px;height:${CANVAS.height}px;background:transparent;
      font-family:Geist,system-ui,sans-serif;color:${BRAND.text};-webkit-font-smoothing:antialiased}
    .mark{background:url(data:image/svg+xml;base64,${logo}) center/contain no-repeat}
    .solid{position:absolute;inset:0;background:
      radial-gradient(1200px 700px at 12% -10%, ${BRAND.azureDeep}55, transparent 60%),
      radial-gradient(900px 600px at 105% 110%, ${BRAND.azure}22, transparent 60%),
      ${BRAND.ink}}
    ${extraCss}
  </style>${body}`
}

/** The frame: everything but the window is painted; the window is a hole. */
function frameHtml(repoRoot: string, title: string): string {
  const w = WINDOW
  return page(
    repoRoot,
    `<svg width="${CANVAS.width}" height="${CANVAS.height}" style="position:absolute;inset:0">
       <defs>
         <mask id="hole"><rect width="100%" height="100%" fill="#fff"/>
           <rect x="${w.x}" y="${w.y}" width="${w.width}" height="${w.height}" rx="${w.radius}" fill="#000"/></mask>
         <radialGradient id="g1" cx="12%" cy="-10%" r="75%"><stop offset="0" stop-color="${BRAND.azureDeep}" stop-opacity=".34"/><stop offset="1" stop-color="${BRAND.azureDeep}" stop-opacity="0"/></radialGradient>
         <radialGradient id="g2" cx="105%" cy="110%" r="60%"><stop offset="0" stop-color="${BRAND.azure}" stop-opacity=".14"/><stop offset="1" stop-color="${BRAND.azure}" stop-opacity="0"/></radialGradient>
       </defs>
       <g mask="url(#hole)">
         <rect width="100%" height="100%" fill="${BRAND.ink}"/>
         <rect width="100%" height="100%" fill="url(#g1)"/>
         <rect width="100%" height="100%" fill="url(#g2)"/>
       </g>
       <rect x="${w.x - 1}" y="${w.y - 1}" width="${w.width + 2}" height="${w.height + 2}" rx="${w.radius + 1}"
         fill="none" stroke="${BRAND.azure}" stroke-opacity=".4" stroke-width="2"/>
     </svg>
     <div class="bar">
       <div class="brand"><div class="mark"></div><span>${BRAND.name}</span></div>
       <h1>${escapeHtml(title)}</h1>
       <div class="site">${BRAND.helpSite}</div>
     </div>`,
    `.bar{position:absolute;left:${w.x}px;top:0;width:${w.width}px;height:${w.y}px;display:flex;align-items:center;gap:36px}
     .brand{display:flex;align-items:center;gap:14px;font-size:30px;font-weight:650;letter-spacing:-.01em}
     .brand .mark{width:52px;height:52px}
     h1{flex:1;font-size:46px;font-weight:600;letter-spacing:-.02em;line-height:1.1;
        padding-left:36px;border-left:2px solid ${BRAND.azure}66;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
     .site{font-size:24px;color:${BRAND.dim}}`,
  )
}

function introHtml(repoRoot: string, title: string): string {
  return page(
    repoRoot,
    `<div class="solid"></div><div class="c">
       <div class="brand"><div class="mark"></div><span>${BRAND.name}</span></div>
       <div class="kicker">Tutorial</div>
       <h1>${escapeHtml(title)}</h1>
     </div>`,
    `.c{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 200px}
     .brand{display:flex;align-items:center;gap:20px;font-size:44px;font-weight:650}
     .brand .mark{width:84px;height:84px}
     .kicker{margin-top:90px;font-size:30px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:${BRAND.azure}}
     h1{margin-top:18px;font-size:104px;font-weight:600;letter-spacing:-.03em;line-height:1.05;max-width:1400px}`,
  )
}

function outroHtml(repoRoot: string): string {
  return page(
    repoRoot,
    `<div class="solid"></div><div class="c">
       <div class="mark"></div>
       <h1>${BRAND.tagline}</h1>
       <p>More tutorials at <b>${BRAND.helpSite}</b></p>
     </div>`,
    `.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
     .mark{width:150px;height:150px}
     h1{margin-top:48px;font-size:88px;font-weight:600;letter-spacing:-.03em}
     p{margin-top:28px;font-size:36px;color:${BRAND.dim}} b{color:${BRAND.azureSoft};font-weight:600}`,
  )
}

/** Draw one video's cards into `dir`. */
export async function drawCards(repoRoot: string, dir: string, id: string, title: string): Promise<CardPaths> {
  const paths: CardPaths = {
    frame: path.join(dir, `${id}.frame.png`),
    intro: path.join(dir, `${id}.intro.png`),
    outro: path.join(dir, `${id}.outro.png`),
  }
  const browser = await chromium.launch()
  try {
    const tab = await browser.newPage({ viewport: { width: CANVAS.width, height: CANVAS.height } })
    const shots: [string, string, boolean][] = [
      [paths.frame, frameHtml(repoRoot, title), true],
      [paths.intro, introHtml(repoRoot, title), false],
      [paths.outro, outroHtml(repoRoot), false],
    ]
    for (const [file, html, seeThrough] of shots) {
      await tab.setContent(html)
      // A string, not a function: scripts/ is checked without the DOM types.
      await tab.evaluate("document.fonts.ready")
      await tab.screenshot({ path: file, omitBackground: seeThrough })
    }
  } finally {
    await browser.close()
  }
  return paths
}
