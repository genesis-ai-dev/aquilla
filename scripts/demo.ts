/**
 * `pnpm demo` — the product story in two minutes, on real files.
 *
 * Creates ./demo-workspace, drops in an InDesign brochure, a Markdown
 * handbook and app strings, and walks through: translate once → a person
 * fixes the French in "InDesign" → the English changes → only what changed is
 * retranslated and the human fix survives → an org decision propagates → a
 * correction made once spreads → any file in any language on demand.
 *
 *   pnpm demo            deterministic pseudo-translation (no network)
 *   pnpm demo --claude   real translation via Claude (needs ANTHROPIC_API_KEY)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { idmlAdapter } from "../src/adapters/idml/index.ts"
import { entryText, readZip, rewriteZip } from "../src/adapters/zip.ts"
import { main as cli, printSummary } from "../src/ambient/cli.ts"
import { Workspace } from "../src/ambient/workspace.ts"
import { brochureSpec, buildIdml } from "../src/fixtures/build-idml.ts"
import { materialize } from "../src/ambient/ops.ts"

const ROOT = join(import.meta.dirname, "..", "demo-workspace")
const useClaude = process.argv.includes("--claude")
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`
let step = 0
const say = (title: string, body = ""): void => {
  console.log(`\n${bold(`${++step}. ${title}`)}${body ? `\n${dim(body)}` : ""}`)
}
const frTexts = (): string[] => idmlAdapter.extract(new Uint8Array(readFileSync(join(ROOT, "translations/fr/brochure.idml"))), "x").units.map((u) => u.plain)
const quiet = async (args: string[]): Promise<void> => {
  const log = console.log
  console.log = () => {}
  try {
    await cli(args)
  } finally {
    console.log = log
  }
}

if (useClaude && !process.env.ANTHROPIC_API_KEY) {
  console.error("--claude needs ANTHROPIC_API_KEY")
  process.exit(1)
}
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })

say("An ordinary folder becomes multilingual", `ambient init ${relative(process.cwd(), ROOT)} --source en --targets fr,de`)
Workspace.init(ROOT, { sourceLocale: "en", targets: ["fr", "de"], translator: useClaude ? "claude" : "pseudo", orgContext: "A community choir. Warm, plain, welcoming tone." })
writeFileSync(join(ROOT, "brochure.idml"), buildIdml(brochureSpec()))
writeFileSync(
  join(ROOT, "handbook.md"),
  "---\ntitle: Choir handbook\n---\n\n# Welcome to the choir\n\nThe **choir** meets every *Thursday* in the church hall. See [the calendar](https://example.org/cal).\n\n- Bring water\n- Bring a pencil\n\n```sh\nchoir --help   # never translated\n```\n",
)
writeFileSync(join(ROOT, "app.i18n.json"), JSON.stringify({ nav: { home: "Home", rehearsals: "Rehearsals" }, greeting: "Welcome back, {name}!" }, null, 2) + "\n")
console.log(dim("dropped in: brochure.idml (InDesign), handbook.md, app.i18n.json"))

say("Translate once", "ambient sync")
printSummary(await Workspace.open(ROOT).sync())

say("A French editor fixes a sentence directly in the French InDesign file", "(no TMS, no export/import — they just save the file)")
const frPath = join(ROOT, "translations/fr/brochure.idml")
const zip = readZip(new Uint8Array(readFileSync(frPath)))
const story = entryText(zip.entries.find((e) => e.name === "Stories/Story_u200.xml")!)
const human = "Les répétitions ont lieu chaque jeudi soir dans la salle paroissiale, à dix-neuf heures."
const machine = /<Content>([^<]*Réhéáršálš[^<]*)<\/Content>/.exec(story)?.[1]
let edited = story.replace(machine ?? "\u0000", human)
// …and, while they are in there, prefers "Chorale" to the machine's word for "Choir" in the title.
const title = entryText(zip.entries.find((e) => e.name === "Stories/Story_u100.xml")!)
const choirWord = /Çhöír|Chœur|Chor/.exec(title)?.[0]
writeFileSync(
  frPath,
  rewriteZip(
    zip,
    new Map([
      ["Stories/Story_u200.xml", new TextEncoder().encode(edited)],
      ...(choirWord ? ([["Stories/Story_u100.xml", new TextEncoder().encode(title.replace(choirWord, "Chorale"))]] as const) : []),
    ]),
  ),
)
console.log(`  “${human}”`)

say("Meanwhile, the English source changes", "one paragraph edited (four → five centuries), one paragraph added")
const spec = brochureSpec({
  u200: [
    { runs: [{ text: "Welcome to a new season of the " }, { style: "Bold", text: "Community Choir" }, { text: ". Everyone who loves to sing is welcome, whatever their experience." }] },
    "Rehearsals take place every Thursday evening in the church hall, starting at seven o'clock.",
    { runs: [{ text: "Bring water, a pencil, and your music folder. Page " }, { inline: "variable" }, { text: " lists the full schedule." }], footnote: "Parking is free after six o'clock." },
    "Our spring concert will feature music from five centuries, including two new commissions.",
    "New this year: a beginners' workshop on the first Saturday of every month.",
    { table: [["Month", "Focus"], ["September", "Warm-ups and sight reading"], ["October", "Spring concert repertoire"]] },
    "Questions? Speak to any section leader after rehearsal, or write to the choir office.",
  ],
})
writeFileSync(join(ROOT, "brochure.idml"), buildIdml(spec))

say("Stay translated", "ambient sync — only what changed is translated; the editor's sentence is kept")
printSummary(await Workspace.open(ROOT).sync())
console.log(frTexts().includes(human) ? `  ✓ human sentence preserved verbatim` : "  ✗ human sentence lost")

say("Correct once, propagate", "the editor's word choice became a suggested correction; accept it")
const sugg = [...Workspace.open(ROOT).state().corrections.values()].find((c) => c.status === "suggested")
if (sugg) {
  console.log(`  suggestion: “${sugg.from}” → “${sugg.to}”`)
  process.chdir(ROOT)
  await quiet(["correction", "accept", sugg.id])
  printSummary(await Workspace.open(ROOT).sync())
}

say(
  "An organisation decision touches only the paragraphs it is about",
  "ambient term add \"church hall\" \"salle paroissiale\" --locale fr\n(the brochure's church-hall sentence is human-authored, so it is left alone)",
)
process.chdir(ROOT)
await quiet(["term", "add", "church hall", "salle paroissiale", "--locale", "fr"])
printSummary(await Workspace.open(ROOT).sync())

say("Open any file in any language", "ambient open handbook.md --in sw   (Swahili was never configured)")
const sw = await materialize(Workspace.open(ROOT), "handbook.md", "sw")
console.log(readFileSync(sw, "utf8").split("\n").slice(0, 9).map((l) => `  ${l}`).join("\n"))

say("Everything is inspectable on demand")
console.log("  report:     demo-workspace/ambient-report.md (and .html)")
console.log("  inspector:  pnpm ambient serve demo-workspace   → http://127.0.0.1:4477")
console.log(`  history:    ${Workspace.open(ROOT).state().size} facts in .ambient/ledger.jsonl; every publish can be rolled back`)
if (!existsSync(join(ROOT, "ambient-report.md"))) process.exitCode = 1
