import fs from "node:fs"

const raw = fs.readFileSync("scripts/_tmp-2176-target.html", "utf8")
const parts = raw.split(/\n(?=<p )/g)
console.log("parts", parts.length, "bytes", raw.length)

function slots(html) {
  const re = /data-idml-slot="(\d+)" data-idml-character-style="([^"]+)"[^>]*>([\s\S]*?)<\/span>/g
  const out = []
  let match
  while ((match = re.exec(html))) {
    out.push({
      i: Number(match[1]),
      style: match[2].replace("CharacterStyle/", ""),
      text: match[3].replace(/<[^>]+>/g, ""),
    })
  }
  return out
}

for (const part of parts) {
  const side = part.startsWith("source") || part.startsWith("target") ? part.slice(0, 6) : "html"
  const html = part.replace(/^(source|target)\n/, "")
  const list = slots(html)
  console.log("\n==", side, "slots", list.length, "html", html.length)
  for (const slot of list) {
    const codes = [...slot.text].filter((ch) => ch.charCodeAt(0) > 127).map((ch) => `${ch} U+${ch.codePointAt(0).toString(16)}`)
    console.log(String(slot.i).padStart(2), slot.style.slice(0, 28).padEnd(28), JSON.stringify(slot.text).slice(0, 160), codes.join(" "))
  }
}
