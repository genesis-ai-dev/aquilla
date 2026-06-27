import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
  Label,
} from "codex-web-app"

export function TargetLanguage() {
  return (
    <div style={{ width: 280, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="sel-lang">Target language</Label>
      <Select defaultValue="Tok Pisin">
        <SelectTrigger id="sel-lang" style={{ width: "100%" }}>
          <SelectValue placeholder="Choose a language" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="Tok Pisin">Tok Pisin</SelectItem>
          <SelectItem value="Hiri Motu">Hiri Motu</SelectItem>
          <SelectItem value="English">English</SelectItem>
          <SelectItem value="Spanish">Spanish</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export function Open() {
  return (
    <div style={{ width: 280, minHeight: 220 }}>
      <Select defaultValue="Peer reviewed" defaultOpen>
        <SelectTrigger style={{ width: "100%" }}>
          <SelectValue placeholder="Verse status" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>MRK 4:1 status</SelectLabel>
            <SelectItem value="Draft">Draft</SelectItem>
            <SelectItem value="Peer reviewed">Peer reviewed</SelectItem>
            <SelectItem value="Consultant validated">Consultant validated</SelectItem>
            <SelectSeparator />
            <SelectItem value="Flagged for revision">Flagged for revision</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

export function Disabled() {
  return (
    <div style={{ width: 280, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="sel-src">Source (locked by admin)</Label>
      <Select defaultValue="Greek SBLGNT" disabled>
        <SelectTrigger id="sel-src" style={{ width: "100%" }}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="Greek SBLGNT">Greek SBLGNT</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
