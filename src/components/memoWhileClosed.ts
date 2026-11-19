import { createElement, memo, useState, type ComponentType, type MemoExoticComponent } from "react"

/**
 * A dialog (or sheet, or panel) that does not render while it stays closed
 * (AQU-2654, decision 0013 "closed is unmounted").
 *
 * The workspace renders its dialogs unconditionally with `open={false}`, and
 * every workspace render re-ran each one — the component itself plus the five
 * or six primitives under it — to produce nothing. Rendering them only while
 * open (`{open && <X/>}`) would be the direct fix, but it drops the 100ms exit
 * animation and any state the dialog keeps between opens. This keeps the
 * component MOUNTED and skips its render for as long as it was closed and is
 * still closed:
 *
 *   closed → closed   skipped, whatever else changed
 *   closed → open     renders, with the props of that moment
 *   open   → open     renders as before
 *   open   → closed   renders once more, so the exit animation runs
 *
 * So while closed the component sees no prop changes at all. Only wrap a
 * dialog whose effects do nothing while it is closed (they start with
 * `if (!open) return`, or depend on `open` alone). One that reacts to another
 * prop while closed — resets its format when the active file changes, reports
 * analytics when a checklist completes — would get that change late, in the
 * same commit as the open, where effect order can pick a different winner.
 * `ExportDialog`, `ImportDialog`, `AudioRecordingModal` and
 * `SetupChecklistDrawer` are deliberately not wrapped for that reason.
 */
export function memoWhileClosed<Props extends object>(
  Component: ComponentType<Props>,
  isOpen: (props: Readonly<Props>) => boolean = openProp,
): MemoExoticComponent<ComponentType<Props>> {
  const Memoized = memo(Component, (previous, next) => !isOpen(previous) && !isOpen(next))
  Memoized.displayName = `WhileOpen(${Component.displayName || Component.name || "Component"})`
  return Memoized
}

function openProp(props: object): boolean {
  return Boolean((props as { open?: unknown }).open)
}

/**
 * `memoWhileClosed`, and not mounted at all until the first time it opens.
 *
 * For a dialog a LIST ROW owns: a few hundred rows each mounting a closed
 * dialog (the component and its primitives) is the larger half of the cost,
 * and most rows never open theirs. Once opened it stays mounted, so the exit
 * animation and anything it remembers between opens behave as before.
 */
export function mountOnFirstOpen<Props extends object>(
  Component: ComponentType<Props>,
  isOpen: (props: Readonly<Props>) => boolean = openProp,
): MemoExoticComponent<ComponentType<Props>> {
  function MountOnFirstOpen(props: Props) {
    const open = isOpen(props)
    const [mounted, setMounted] = useState(open)
    if (open && !mounted) setMounted(true)
    return mounted || open ? createElement(Component, props) : null
  }
  const Memoized = memo(MountOnFirstOpen as ComponentType<Props>, (previous, next) => !isOpen(previous) && !isOpen(next))
  Memoized.displayName = `OnFirstOpen(${Component.displayName || Component.name || "Component"})`
  return Memoized
}
