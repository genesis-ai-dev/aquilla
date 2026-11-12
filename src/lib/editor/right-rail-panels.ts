// AQU-1316: decide, for the editor's right rail, which scripture side panels
// are offered and which one is open — Parallel Bibles (helloao), Verse
// Resources (Aquifer, "Helps") and, since AQU-1689, Who's Who ("People").
//
// The three used to be separate collapsed edge tabs, each its own rail, with
// any number of panels open side by side. They are now buttons in one rail
// that switch between panels, so at most one is open. Keeping the decision in
// one pure function keeps that rule checkable: `asideEdge` renders `tabs`,
// `aside` renders `openPanel`.

export interface RightRailInputs {
  /**
   * The center surface is the editor, on a file with sections (the gate both
   * surfaces already shared). False on overlay surfaces (Terminology, Agent, …)
   * and on files with no scripture structure — neither surface exists there.
   */
  inScriptureEditor: boolean
  /**
   * AQU-461: the project's Bible-resources gate. The aquifer routes 404 when it
   * is off, so an ungated Verse Resources surface would only ever show an error.
   */
  verseResourcesAvailable: boolean
  /**
   * AQU-1689: the project's Who's Who enrichment is on (it is off whenever
   * Bible data is) and this device has the Bible data experiment on
   * (AQU-1685). Off, the panel and its edge tab are both gone.
   */
  whosWhoAvailable: boolean
  /** Persisted per-project open flag for Parallel Bibles. */
  parallelBiblesOpen: boolean
  /** Persisted per-project open flag for Verse Resources. */
  verseResourcesOpen: boolean
  /** AQU-1689: persisted per-project open flag for the Who's Who panel. */
  whosWhoOpen: boolean
}

/** One of the scripture side panels the rail switches between. */
export type RightRailPanel = "bibles" | "resources" | "people"

export interface RightRailSurfaces {
  /**
   * The buttons in the single right rail, top to bottom. Empty outside the
   * scripture editor; otherwise every feature that is available, whether or
   * not its panel is open (the open one renders as the active button).
   */
  tabs: RightRailPanel[]
  /** The one panel rendered in `aside`, or null when all are closed. */
  openPanel: RightRailPanel | null
}

/**
 * One rail, one open panel at a time.
 *
 * The rail's buttons switch between panels like tabs, so at most one is open.
 * The open flags are persisted separately per feature (and older sessions may
 * have left several set), so when more than one is set the first in rail order
 * wins. ProjectWorkspace clears the others when it opens one, so that only
 * matters on the first render after an upgrade.
 */
export function computeRightRailSurfaces({
  inScriptureEditor,
  verseResourcesAvailable,
  whosWhoAvailable,
  parallelBiblesOpen,
  verseResourcesOpen,
  whosWhoOpen,
}: RightRailInputs): RightRailSurfaces {
  if (!inScriptureEditor) return { tabs: [], openPanel: null }
  const tabs: RightRailPanel[] = ["bibles"]
  // AQU-461: Verse Resources also needs the project's Bible-resources gate.
  if (verseResourcesAvailable) tabs.push("resources")
  // AQU-1689: Who's Who also needs its own enrichment.
  if (whosWhoAvailable) tabs.push("people")
  const open: Record<RightRailPanel, boolean> = {
    bibles: parallelBiblesOpen,
    resources: verseResourcesOpen,
    people: whosWhoOpen,
  }
  return { tabs, openPanel: tabs.find((tab) => open[tab]) ?? null }
}
