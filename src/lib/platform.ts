// Which keyboard conventions this machine follows. (AQU-646 stage 2b)
//
// THE APP DELIBERATELY DOES NOT CARE ALMOST EVERYWHERE, and that is right:
// every `metaKey || ctrlKey` in the codebase treats the two as interchangeable,
// which is the correct reading for "the additive modifier" on a shortcut. This
// module exists for the ONE place where they are not interchangeable.
//
// On macOS the browser turns **ctrl + primary click into a `contextmenu`
// event**. That is not something we opt into or can suppress — it is the
// platform's own synthesis, and it is how the timeline's track menu opens. So
// on a Mac, ctrl-click cannot ALSO mean "add this track to the selection": the
// same gesture would open a menu and change the selection under it. ⌘ is the
// additive modifier there, as it is in Finder and in Logic.
//
// Everywhere else ctrl IS the additive modifier and there is no conflict, so it
// keeps working.

/**
 * Is this an Apple platform, where ctrl+click is the context-menu gesture?
 *
 * `userAgentData.platform` first (the un-deprecated source), falling back to
 * `navigator.platform`, and finally to the UA string for older browsers.
 * Defaults to FALSE when nothing can be read — in a headless or non-browser
 * environment there is no ctrl+click synthesis to collide with, so treating
 * ctrl as additive is the harmless answer.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false
  const withData = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = withData.userAgentData?.platform ?? navigator.platform ?? ""
  if (platform) return /mac|iphone|ipad|ipod/i.test(platform)
  return /mac|iphone|ipad|ipod/i.test(navigator.userAgent ?? "")
}
