import { Mic2, AudioWaveform, type LucideIcon } from "lucide-react"

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

export function audioLensLabel(timeOrdered: boolean): string {
  return timeOrdered ? "Media" : "Audio"
}

export function audioLensIcon(timeOrdered: boolean): LucideIcon {
  return timeOrdered ? AudioWaveform : Mic2
}
