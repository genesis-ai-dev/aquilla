// Pure time<->pixel math + visibility windowing for the timeline editor.
export const ZOOM_MIN = 8
export const ZOOM_MAX = 240
export const ZOOM_DEFAULT = 38

export const secToPx = (sec: number, pxPerSec: number) => sec * pxPerSec
export const pxToSec = (px: number, pxPerSec: number) => px / pxPerSec

export function clampRange(startSec: number, endSec: number, minDurSec: number) {
  const s = Number.isFinite(startSec) ? Math.max(0, startSec) : 0
  let e = Number.isFinite(endSec) ? endSec : s
  if (e - s < minDurSec) e = s + minDurSec
  return { startSec: s, endSec: e }
}

export function isVisible(startSec: number, endSec: number, viewStartSec: number, viewEndSec: number) {
  return startSec < viewEndSec && viewStartSec < endSec
}
