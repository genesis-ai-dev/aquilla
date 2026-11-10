// AQU-2491 (review, Nov 9): HOW FAR A PRESS MUST TRAVEL BEFORE IT IS A DRAG.
//
// A mouse barely wanders between press and release: 3 px. A fingertip's tap
// often moves 8–10 px (the touch slop phones and tablets use themselves), so on
// a phone or an iPad the mouse's 3 px read a tap on a take as a move, on a cue
// as a retime, and on a track's row as a drag that swallowed the tap. The app
// had no rule of its own for touch, so a finger or a pen gets the platforms'.

/** A mouse's press is a drag once it has moved this far. */
export const MOUSE_DRAG_SLOP_PX = 3
/** A finger's or a pen's. */
export const TOUCH_DRAG_SLOP_PX = 10

/** The distance a press must travel to be a drag, for the pointer that made it. */
export function dragSlopPx(pointerType: string | undefined): number {
  return pointerType === "touch" || pointerType === "pen" ? TOUCH_DRAG_SLOP_PX : MOUSE_DRAG_SLOP_PX
}
