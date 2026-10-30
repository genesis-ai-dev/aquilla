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
   * Q4, what the Station's Undo button undoes: "thisRecording" = your last
   * change to the open recording (greyed, with a reason, when your newest
   * change in the project was elsewhere); "project" = the project's Undo.
   */
  undoButton: "thisRecording" as "thisRecording" | "project",
  /**
   * Q9, when volume and fades are heard outside the Station: "together" =
   * the Station's volume and fades appear only once the timeline and the
   * exports honour them (the mixer, slice 8); "stationFirst" = shown in the
   * Station at once, before the timeline and exports hear them.
   */
  levelsRelease: "together" as "together" | "stationFirst",
  /** Q12: History says who made each change, and when. */
  historyNamesWho: true,
  /** Q13: with more than one approval needed, "Waiting · 1 of 2". */
  showApprovalCount: true,
} as const

/** Q8: Loop is a button after the speed menu; L toggles it. */
export const LOOP_KEY = "l"
