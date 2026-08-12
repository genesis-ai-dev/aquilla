import { Mic2, AudioWaveform, type LucideIcon } from "lucide-react"
import type { MessageKey } from "@/lib/i18n/messages/en"

// AQU-353: single source of truth for how the second editor lens is labelled and
// iconified. Two entry points toggle the SAME Text/Audio lens — the header
// segmented control (EditorModeToggle) and the sidebar "More" nav item — so they
// must read as one feature: same name, same icon. Previously the sidebar said
// "Voice" while the header said "Audio", so testers hit what looked like two
// different destinations. Route every entry point through these helpers instead
// of hand-labelling, so the names can never drift apart again.
//
// Cell-ordered files expose an audio lens ("Audio", Mic2); time-ordered files
// expose a media lens ("Media", AudioWaveform).
//
// This module has no React context of its own (it's a plain lib file), so it
// returns the catalog KEY rather than a resolved string — callers with a `t()`
// in scope resolve it at render. Returning a `MessageKey` keeps the same
// "unkeyed string is a compile error" guarantee `LeftDock.tsx`'s `TabMeta`
// pattern gets from a typed field.

export function audioLensLabelKey(timeOrdered: boolean): MessageKey {
  return timeOrdered ? "nav.lens.media" : "nav.lens.audio"
}

export function audioLensIcon(timeOrdered: boolean): LucideIcon {
  return timeOrdered ? AudioWaveform : Mic2
}
