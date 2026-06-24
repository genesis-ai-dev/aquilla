// transformers.js fires its progress_callback on every network chunk read —
// hundreds of times per second on a fast connection. Each event is posted from
// a model worker to the main thread, where the download-progress stores fan it
// out to every subscribed cell row (useTranscribeStatus / useModelStatus),
// re-running getSnapshot across the whole editor table. Unthrottled, that
// saturates the main thread and freezes the UI for the entire download.
//
// Coalesce the high-frequency streaming statuses to a fixed cadence; let every
// other status (initiate / download / done / ready / cached / downloaded / …)
// through immediately so the bar still initialises and settles. Dropping
// intermediate ticks is safe — the bar is monotonic and the terminal event
// delivers the final state.
//
// "progress" is transformers.js's per-chunk status; "downloading" is the
// equivalent for the MMS/Sherpa manual fetch loop.

const PROGRESS_THROTTLE_MS = 100
const HIGH_FREQUENCY_STATUSES = new Set(["progress", "downloading"])

export function throttleModelProgress(
  emit: (info: unknown) => void,
  intervalMs: number = PROGRESS_THROTTLE_MS,
): (info: unknown) => void {
  let lastEmit = -Infinity
  return (info: unknown) => {
    const status = (info as { status?: string } | null | undefined)?.status
    if (status && HIGH_FREQUENCY_STATUSES.has(status)) {
      const now = performance.now()
      if (now - lastEmit < intervalMs) return
      lastEmit = now
    }
    emit(info)
  }
}
