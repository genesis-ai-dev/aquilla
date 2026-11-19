// AQU-2680: open a page in the browser's print window, where the person picks
// "Save as PDF" (the PDF export, question 54). The page is printed from a
// hidden frame in the app's own page, not a new tab: a new tab opened after
// the export's own work is blocked as a pop-up in most browsers.
//
// Says whether the print window opened. It did not when the browser has no
// printing (`print` missing or failing, the frame never loading), or when
// the app runs in another app's built-in browser (Facebook, Instagram,
// LINE, WeChat, an Android web view), whose `print()` does nothing at all.
// The caller then gives the Word file instead. What the person does in the
// print window (save, print or cancel) is theirs: a cancel saves nothing.

/** A frame's window, as far as printing needs it. */
export interface PrintableWindow {
  print: () => void
  focus?: () => void
  addEventListener?: (type: "afterprint", listener: () => void) => void
}

export interface PrintOptions {
  /** Load the page somewhere printable; default: a hidden frame in this page. */
  open?: (html: string) => Promise<{ win: PrintableWindow | null; close: () => void }>
  /** Default: the browser's own. */
  userAgent?: string
  /** How long the page may take to load before printing counts as unavailable. */
  loadTimeoutMs?: number
}

/** Built-in browsers of other apps, where `print()` is a silent no-op.
 *  AQU-2680 re-check finding 3: others (Gmail, Slack, X, LinkedIn, Telegram
 *  on iPhone) don't name themselves; the dialog offers the Word file beside
 *  the print message for them. */
const IN_APP_BROWSER = /\b(FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat)\b|; wv\)/i

const LOAD_TIMEOUT_MS = 10_000

/** The frame of the last print; it stays until the next one, as some
 *  browsers keep reading it while their print window is open. */
let lastFrame: HTMLIFrameElement | null = null

function openInFrame(html: string, timeoutMs: number): Promise<{ win: PrintableWindow | null; close: () => void }> {
  lastFrame?.remove()
  const frame = document.createElement("iframe")
  frame.setAttribute("aria-hidden", "true")
  frame.tabIndex = -1
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden"
  lastFrame = frame
  const close = () => {
    frame.remove()
    if (lastFrame === frame) lastFrame = null
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ win: null, close }), timeoutMs)
    frame.addEventListener("load", () => {
      clearTimeout(timer)
      resolve({ win: frame.contentWindow as PrintableWindow | null, close })
    }, { once: true })
    frame.srcdoc = html
    document.body.appendChild(frame)
  })
}

export async function printHtml(html: string, options?: PrintOptions): Promise<boolean> {
  const userAgent = options?.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent)
  if (IN_APP_BROWSER.test(userAgent)) return false
  let opened: { win: PrintableWindow | null; close: () => void }
  try {
    opened = await (options?.open ?? ((h) => openInFrame(h, options?.loadTimeoutMs ?? LOAD_TIMEOUT_MS)))(html)
  } catch {
    return false
  }
  const { win, close } = opened
  if (!win || typeof win.print !== "function") {
    close()
    return false
  }
  try {
    win.addEventListener?.("afterprint", close)
    // AQU-2680 re-check finding 4: Safari prints the focused window, which
    // without this can be the app's page rather than the frame.
    win.focus?.()
    win.print()
    return true
  } catch {
    close()
    return false
  }
}
