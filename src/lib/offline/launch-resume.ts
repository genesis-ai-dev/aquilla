// Desktop: whether this launch reopened the last project offline
// (OfflineLaunchResume), so a launch with an expired session isn't sent to
// sign-in — which can't work offline — before it has had the chance.
import { isTauriRuntime } from "./is-tauri"

let settle: (resumed: boolean) => void = () => {}
const settled = new Promise<boolean>((resolve) => {
  settle = resolve
})
// Nothing to wait for outside the desktop app.
if (!isTauriRuntime()) settle(false)

/** Records the launch's decision: true if it reopened the last project. First call wins. */
export function settleOfflineLaunchResume(resumed: boolean): void {
  settle(resumed)
}

/** Resolves once the launch has decided; true if it reopened the last project. */
export function whenOfflineLaunchResumeSettled(): Promise<boolean> {
  return settled
}
