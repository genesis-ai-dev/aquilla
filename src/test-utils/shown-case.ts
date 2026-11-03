// AQU-2332: what a test can say about how text is cased on screen.

/**
 * The case a reader sees, from the nearest Tailwind case class on the element
 * or above it. jsdom applies no CSS, so `textContent` alone would read
 * "Project lead" even when the screen shows "Project Lead".
 */
export function shownCase(el: HTMLElement): "as written" | "capitalize" | "uppercase" | "lowercase" {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.classList.contains("normal-case")) return "as written"
    for (const c of ["capitalize", "uppercase", "lowercase"] as const) if (node.classList.contains(c)) return c
  }
  return "as written"
}
