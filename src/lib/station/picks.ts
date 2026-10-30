// The Station's open questions for Sam (AQU-2327, station-spec/questions.md),
// each answered here with my pick and nowhere else, so his answer is a small
// change to this file. Every other rule comes from the mock-ups (boards 40
// and 40b) and the decision log.

export const STATION_PICKS = {
  /**
   * Q1, the way in. "Edit in the Station" on every take's ⋯ menu (right-click
   * and hover ⋯) and on the Recording tab's take. While the Station's tab is
   * showing, a click on another take on the timeline opens that one. The tab
   * is always there on media files, a quiet tab behind Lines until chosen.
   */
  wayIn: {
    takeMenuItem: true,
    recordingTabButton: true,
    followTimelineSelection: true,
    tabAlwaysPresent: true,
  },
  /**
   * Q2, how a saved version shows in the line's takes: "under" keeps the
   * take's name with "version N" after it, the earlier version folded under
   * it; "newTake" would give it the next take number, as Remove noise does.
   */
  versions: "under" as "under" | "newTake",
  /**
   * Q4, what the Station's Undo button undoes — Sam, Oct 30: "thisRecording"
   * = always your last change to the open recording, even if you have changed
   * other things since (it is never greyed for that); "project" = the
   * project's newest step. ⌘Z is the project's newest step either way.
   */
  undoButton: "thisRecording" as "thisRecording" | "project",
  /**
   * Q9, when volume and fades are heard outside the Station: "together" =
   * the Station's volume and fades appear only once the timeline and the
   * exports honour them (the mixer, slice 8); "stationFirst" = shown in the
   * Station at once, before the timeline and exports hear them.
   */
  levelsRelease: "together" as "together" | "stationFirst",
  /**
   * Q3 (Sam, Oct 30): no recordings Library yet, so "Insert audio here › From
   * the library" and "Show in the library" stay hidden. AQU-2333 brings them
   * back when the Library exists; flip this then.
   */
  library: false,
  /**
   * Q10 (Sam, Oct 30): the imported source recording opens to listen, select
   * and loop, with its editing tools hidden and a plain line saying why. Sam
   * may allow editing source lines later: this is that switch.
   */
  sourceEditable: false,
  /**
   * Q12: History says who made each change, and when (Sam likes it, Oct 30).
   * His pinned idea for later: a line's Recording tab could become the take's
   * history of changes, as text has its edit history — the Station's History
   * reads the same server history (cell-history-read-route), so it can feed
   * that. Q7: the Station never replaces the Recording tab.
   */
  historyNamesWho: true,
  /** Q13: with more than one approval needed, "Waiting · 1 of 2". */
  showApprovalCount: true,
} as const

/**
 * Q9's switch: the timeline and the exports apply a clip's volume and fades
 * (the playback mixer, slice 8). With "together", the Station shows its volume
 * line and fade corners only once this is true.
 */
export const MIXER_READY = true

/** The Station shows its volume and fade controls (items 21–22). */
export const levelsShown = (): boolean => STATION_PICKS.levelsRelease === "stationFirst" || MIXER_READY

/** Q8: Loop is a button after the speed menu; L toggles it. */
export const LOOP_KEY = "l"
