import { Textarea, Label } from "codex-web-app"

export function Default() {
  return (
    <div style={{ width: 380, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="ta-notes">Translator notes</Label>
      <Textarea
        id="ta-notes"
        rows={4}
        defaultValue="Prefer dynamic equivalence for idioms; keep proper nouns transliterated. Flag MRK 4:12 for consultant review."
      />
    </div>
  )
}

export function Placeholder() {
  return (
    <div style={{ width: 380, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="ta-bt">Back-translation</Label>
      <Textarea id="ta-bt" rows={4} placeholder="Type a literal English rendering of the Tok Pisin draft…" />
    </div>
  )
}

export function Disabled() {
  return (
    <div style={{ width: 380, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="ta-src">Source text (read from SBLGNT)</Label>
      <Textarea
        id="ta-src"
        rows={3}
        disabled
        defaultValue="Καὶ πάλιν ἤρξατο διδάσκειν παρὰ τὴν θάλασσαν."
      />
    </div>
  )
}

export function Invalid() {
  return (
    <div style={{ width: 380, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="ta-err">Draft for MRK 4:1</Label>
      <Textarea id="ta-err" rows={3} aria-invalid defaultValue="" placeholder="Draft cannot be empty before commit" />
    </div>
  )
}
