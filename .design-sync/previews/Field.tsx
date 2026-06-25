import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  Input,
  Textarea,
} from "codex-web-app"

export function TextField() {
  return (
    <div style={{ width: 360 }}>
      <Field>
        <FieldLabel htmlFor="project-name">Project name</FieldLabel>
        <Input id="project-name" defaultValue="Gospel of Mark — Tok Pisin" />
        <FieldDescription>
          Shown to everyone you share this translation with.
        </FieldDescription>
      </Field>
    </div>
  )
}

export function WithError() {
  return (
    <div style={{ width: 360 }}>
      <Field data-invalid>
        <FieldLabel htmlFor="verse-ref">Verse reference</FieldLabel>
        <Input id="verse-ref" defaultValue="MRK 99:1" aria-invalid />
        <FieldError errors={[{ message: "Mark has only 16 chapters." }]} />
      </Field>
    </div>
  )
}

export function FieldGroupExample() {
  return (
    <div style={{ width: 360 }}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="source-lang">Source language</FieldLabel>
          <Input id="source-lang" defaultValue="Greek (SBLGNT)" />
        </Field>
        <Field>
          <FieldLabel htmlFor="notes">Translator notes</FieldLabel>
          <Textarea
            id="notes"
            rows={3}
            defaultValue="Prefer dynamic equivalence for idioms; keep proper nouns transliterated."
          />
          <FieldDescription>Visible to reviewers only.</FieldDescription>
        </Field>
      </FieldGroup>
    </div>
  )
}
