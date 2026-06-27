import { Switch, Label } from "codex-web-app"

export function On() {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <Switch id="sw-bt" defaultChecked />
      <Label htmlFor="sw-bt">Auto-backtranslation</Label>
    </div>
  )
}

export function Off() {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <Switch id="sw-tts" />
      <Label htmlFor="sw-tts">Read draft aloud (TTS)</Label>
    </div>
  )
}

export function Small() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Switch id="sw-sm-on" size="sm" defaultChecked />
        <Label htmlFor="sw-sm-on">Show health rings</Label>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Switch id="sw-sm-off" size="sm" />
        <Label htmlFor="sw-sm-off">Highlight key terms</Label>
      </div>
    </div>
  )
}

export function Disabled() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Switch id="sw-dis-on" defaultChecked disabled />
        <Label htmlFor="sw-dis-on">Sync to GitLab (managed)</Label>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Switch id="sw-dis-off" disabled />
        <Label htmlFor="sw-dis-off">Offline drafting</Label>
      </div>
    </div>
  )
}

export function SettingsRow() {
  return (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Label htmlFor="sr-1">Require consultant approval</Label>
        <Switch id="sr-1" defaultChecked />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Label htmlFor="sr-2">Lock validated verses</Label>
        <Switch id="sr-2" />
      </div>
    </div>
  )
}
