/** Each SQL statement in a cookbook: a line starting with SELECT plus the
 *  clause lines that follow it. */
export function sqlStatements(text: string): string[] {
  const out: string[] = []
  let current: string[] | null = null
  for (const line of text.split("\n")) {
    if (line.startsWith("SELECT")) {
      if (current) out.push(current.join("\n"))
      current = [line]
    } else if (current && /^(FROM|WHERE|ORDER BY|GROUP BY|LIMIT)\b|^\s+\S/.test(line)) {
      current.push(line)
    } else if (current) {
      out.push(current.join("\n"))
      current = null
    }
  }
  if (current) out.push(current.join("\n"))
  return out
}
