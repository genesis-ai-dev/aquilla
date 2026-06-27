import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
  Label,
} from "codex-web-app"
import { SearchIcon, BookOpenIcon } from "lucide-react"

export function SearchVerses() {
  return (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label>Search verses</Label>
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput placeholder="Search Gospel of Mark…" />
      </InputGroup>
    </div>
  )
}

export function VerseRefPrefix() {
  return (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label>Go to verse</Label>
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>MRK</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput defaultValue="4:1" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton variant="default">Go</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

export function CommitDraft() {
  return (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label>Draft for MRK 4:1</Label>
      <InputGroup>
        <InputGroupTextarea
          rows={3}
          defaultValue="Na em i kirap gen long skulim ol manmeri klostu long raunwara."
        />
        <InputGroupAddon align="block-end">
          <InputGroupText>
            <BookOpenIcon /> Tok Pisin
          </InputGroupText>
          <InputGroupButton variant="default" style={{ marginLeft: "auto" }}>
            Commit
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

export function Disabled() {
  return (
    <div style={{ width: 360, display: "flex", flexDirection: "column", gap: 6 }}>
      <Label>Locked verse</Label>
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>MRK 4:1</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput defaultValue="Validated — read only" disabled />
      </InputGroup>
    </div>
  )
}
