// Is a recording surface holding the microphone right now? (AQU-646)
//
// A three-line store, and it exists for one narrow purpose: so code far from
// the recorder can refuse to TOUCH THE AUDIO DEVICE while a take is possible.
// Creating or first-resuming an AudioContext is the operation that makes the
// browser/OS reconfigure the shared device, and on a headset that reaches the
// microphone — the bug that ate the head of a take twice.
//
// Deliberately NOT inferred from the shortcut-override stack in
// audio-coordinator: that answers "who owns the spacebar", and the playback bar
// pushes onto it too, so it would say yes in situations that have nothing to do
// with the mic.
//
// Written from the recorder's open/closed state rather than from a take's
// start/stop, and that is on purpose: `holdMic` keeps one stream and one armed
// capture graph alive ACROSS takes (churning them between takes is what put a
// recovery ramp under the next take's first word), so "the recorder is open" is
// the honest boundary. It is a strict superset of "a take is running", and for
// a rule that means "do not disturb the device", the superset is the safe side.

let held = false

export function setMicHeld(next: boolean): void {
  held = next
}

export function micIsHeld(): boolean {
  return held
}

/** Module state outlives a test file; reset it or one test's recorder leaks
 *  into the next one's expectations. */
export function __resetMicHoldForTests(): void {
  held = false
}
