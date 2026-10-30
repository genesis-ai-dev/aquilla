// Preferences → Recording (AQU-2264): the recorder's and the timeline's
// preferences in one place.
//
// The same settings as the recorder's ⚙, its WAV / COMPRESSED button, its film
// controls, and the timeline's Follow playhead and snap magnet — two doors, one
// setting: each control here reads and writes the very preference those do, so
// a change in either place shows in the other at once. Signed in, they follow
// the person to every device (src/lib/prefs/person-prefs.ts); signed out they
// stay on this device, and the page says so.
//
// What each one does is behind its (i), on click, opening in place.

import { useId, type ReactNode } from "react"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { SegmentTabs } from "@/components/ui/tabs"
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { usePersonPref } from "@/lib/prefs/person-prefs"
import { timelineFollowPlayheadPref, timelineSnapPref } from "@/lib/prefs/person-pref-list"
import {
  COUNTDOWN_SPEEDS,
  setRecordingCountdownBeep,
  setRecordingCountdownSpeed,
  useRecordingCountdownBeep,
  useRecordingCountdownSpeed,
  type CountdownSpeed,
} from "@/lib/store/recording-countdown-pref"
import { setRecordingAutoAdvance, useRecordingAutoAdvance } from "@/lib/store/recording-auto-advance-pref"
import { setRecordingTakesDrawerOpen, useRecordingTakesDrawerOpen } from "@/lib/store/recording-takes-drawer-pref"
import { setRecordingFormatPref, useRecordingFormatPref, type RecordingFormat } from "@/lib/store/recording-format-pref"
import { setRecordingFilmAudible, useRecordingFilmAudible } from "@/lib/store/recording-film-audible-pref"
import { setRecordingVideoCollapsed, useRecordingVideoCollapsed } from "@/lib/store/recording-video-collapsed-pref"

const SPEED_LABEL_KEYS: Record<CountdownSpeed, MessageKey> = {
  off: "audio.recordingModal.countdownSpeedOff",
  fast: "audio.recordingModal.countdownSpeedFast",
  normal: "audio.recordingModal.countdownSpeedNormal",
  slow: "audio.recordingModal.countdownSpeedSlow",
}

const FORMATS: { value: RecordingFormat; labelKey: MessageKey }[] = [
  { value: "wav", labelKey: "settings.preferences.recording.formatWav" },
  { value: "webm", labelKey: "settings.preferences.recording.formatCompressed" },
]

/** One setting: its name with an (i), what it does opening under the name on
 *  click, and its control at the right. `labels` = the control is a single
 *  input with this id, so the name is its <label>. */
function PrefRow({ id, title, info, control, labels = false }: {
  id: string
  title: string
  info: string
  control: ReactNode
  labels?: boolean
}) {
  const t = useT()
  const [open, toggle] = useInfoOpen()
  const infoId = useId()
  return (
    <SettingsRow
      label={
        <span className="flex items-center gap-1.5" data-testid={`${id}-title`}>
          {labels ? <label htmlFor={id}>{title}</label> : <span>{title}</span>}
          <InfoToggle
            open={open}
            onToggle={toggle}
            label={t("common.aboutAria", { name: title })}
            controls={infoId}
            testId={`${id}-info-toggle`}
          />
        </span>
      }
      description={
        <InfoReveal open={open} id={infoId} testId={`${id}-info`}>
          {info}
        </InfoReveal>
      }
      control={control}
    />
  )
}

function PrefSwitch({ id, title, info, checked, disabled, onCheckedChange }: {
  id: string
  title: string
  info: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (next: boolean) => void
}) {
  return (
    <PrefRow
      id={id}
      title={title}
      info={info}
      labels
      control={
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={(next) => onCheckedChange(next)} />
      }
    />
  )
}

/** Second sentence of the page's description: whether these follow the
 *  person or stay on this device. */
export function RecordingPreferencesScope() {
  const t = useT()
  const { session } = useFrontierSession()
  return (
    <span data-testid="recording-prefs-scope">
      {session
        ? t("settings.preferences.recording.followsYou")
        : t("settings.preferences.recording.thisDeviceOnly")}
    </span>
  )
}

export function RecordingPreferencesSection() {
  const t = useT()
  const countdown = useRecordingCountdownSpeed()
  const beep = useRecordingCountdownBeep()
  const moveOn = useRecordingAutoAdvance()
  const takesDrawerOpen = useRecordingTakesDrawerOpen()
  const format = useRecordingFormatPref()
  const filmAudible = useRecordingFilmAudible()
  const filmCollapsed = useRecordingVideoCollapsed()
  const followPlayhead = usePersonPref(timelineFollowPlayheadPref)
  const snap = usePersonPref(timelineSnapPref)

  return (
    <>
      <SettingsGroup label={t("settings.preferences.recording.recorderGroup")}>
        <PrefRow
          id="pref-rec-countdown"
          title={t("audio.recordingModal.countdownTitle")}
          info={t("settings.preferences.recording.countdownInfo")}
          control={
            <SegmentTabs<CountdownSpeed>
              value={countdown}
              onValueChange={setRecordingCountdownSpeed}
              aria-label={t("audio.recordingModal.countdownTitle")}
              options={COUNTDOWN_SPEEDS.map((speed) => ({ value: speed, label: t(SPEED_LABEL_KEYS[speed]) }))}
            />
          }
        />
        <PrefSwitch
          id="pref-rec-beep"
          title={t("audio.recordingModal.beepTitle")}
          info={t("settings.preferences.recording.beepInfo")}
          checked={beep}
          // As in the recorder: with no count there is nothing to beep, and the
          // setting is kept, untouched, for when the count is back.
          disabled={countdown === "off"}
          onCheckedChange={setRecordingCountdownBeep}
        />
        <PrefSwitch
          id="pref-rec-move-on"
          title={t("audio.recordingModal.autoAdvanceTitle")}
          info={t("settings.preferences.recording.moveOnInfo")}
          checked={moveOn}
          onCheckedChange={setRecordingAutoAdvance}
        />
        <PrefSwitch
          id="pref-rec-takes-drawer"
          title={t("audio.recordingModal.takesDrawerTitle")}
          info={t("settings.preferences.recording.takesDrawerInfo")}
          checked={takesDrawerOpen}
          onCheckedChange={setRecordingTakesDrawerOpen}
        />
        <PrefRow
          id="pref-rec-format"
          title={t("settings.preferences.recording.formatTitle")}
          info={t("settings.preferences.recording.formatInfo")}
          control={
            <SegmentTabs<RecordingFormat>
              value={format}
              onValueChange={setRecordingFormatPref}
              aria-label={t("settings.preferences.recording.formatTitle")}
              options={FORMATS.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
            />
          }
        />
        <PrefSwitch
          id="pref-rec-show-film"
          title={t("settings.preferences.recording.showFilmTitle")}
          info={t("settings.preferences.recording.showFilmInfo")}
          checked={!filmCollapsed}
          onCheckedChange={(show) => setRecordingVideoCollapsed(!show)}
        />
        <PrefSwitch
          id="pref-rec-film-sound"
          title={t("settings.preferences.recording.filmSoundTitle")}
          info={t("settings.preferences.recording.filmSoundInfo")}
          checked={filmAudible}
          onCheckedChange={setRecordingFilmAudible}
        />
      </SettingsGroup>
      <SettingsGroup label={t("editor.timeline.title")}>
        <PrefSwitch
          id="pref-tl-follow"
          title={t("editor.timeline.followPlayhead")}
          info={t("settings.preferences.recording.followInfo")}
          checked={followPlayhead}
          onCheckedChange={(on) => timelineFollowPlayheadPref.set(on)}
        />
        <PrefSwitch
          id="pref-tl-snap"
          title={t("editor.timeline.snapToggleAria")}
          info={t("settings.preferences.recording.snapInfo")}
          checked={snap}
          onCheckedChange={(on) => timelineSnapPref.set(on)}
        />
      </SettingsGroup>
    </>
  )
}
