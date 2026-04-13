export function tokenizeText(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/<[^>]*?>/g, " ")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}
