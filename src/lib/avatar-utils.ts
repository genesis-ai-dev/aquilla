export function initialsFromName(name: string): string {
  const t = name.trim()
  if (!t) return "?"
  const parts = t.split(/\s+/)
  if (parts.length === 1) return t.slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function singleInitialFromName(name: string): string {
  const t = name.trim()
  if (!t) return "?"
  return t[0].toUpperCase()
}

export function colorFromName(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return `hsl(${Math.abs(h) % 360}, 55%, 45%)`
}
