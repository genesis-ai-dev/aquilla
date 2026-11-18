// French no-break spaces for the Word export (AQU-2539).
//
// A LANGUAGE-SPECIFIC CASE, deliberately small: French typography keeps the
// space before ; : ! ? » and after « on the same line as the mark. When the
// target language is French, translated text written into a Word file has an
// ordinary space in those places swapped for a no-break space (U+00A0). Only
// an existing ordinary space is replaced; none is added, nothing else changes,
// and the text keeps its length (the exporter relies on that). Used only by
// the Word exporter.

/** True for `fr` and any `fr-*` tag. */
export function isFrenchLanguage(tag: string | null | undefined): boolean {
  return typeof tag === "string" && /^fr(?:[-_]|$)/i.test(tag.trim())
}

export function frenchSpacing(text: string): string {
  return text.replace(/ (?=[;:!?»])/g, " ").replace(/(?<=«) /g, " ")
}
