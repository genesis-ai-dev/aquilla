// Proves a built desktop release is safe to offer to installed apps, before
// it becomes the "latest" release their updater reads. What it checks and why
// is in docs/DESKTOP-RELEASES.md ("What verification proves").
//
//   tsx scripts/desktop-release-verify.ts v0.2.5              all platforms' update files
//   tsx scripts/desktop-release-verify.ts v0.2.5 --launch     also install and start this OS's build
//   tsx scripts/desktop-release-verify.ts v0.2.5 --dir <dir>  use already-downloaded assets
//
// Without --dir it needs the `gh` CLI, signed in as someone who can see the
// release (a draft is invisible to everyone else).
// Exits 1 on the first group of problems, naming each one.

import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { manifestProblems, parseUpdaterManifest, verifyUpdaterSignature, type UpdaterManifest } from "./lib/desktop-release"

const root = path.resolve(import.meta.dirname, "..")
const argv = process.argv.slice(2)
const tag = argv.find((a) => /^v\d/.test(a))
const launch = argv.includes("--launch")
const dirFlag = argv.indexOf("--dir")
if (!tag) {
  process.stderr.write("usage: desktop-release-verify.ts <vX.Y.Z> [--launch] [--dir <assets dir>]\n")
  process.exit(2)
}

/** How long a started app must stay up to count as having launched. */
const ALIVE_MS = 30_000

const log = (line: string) => process.stdout.write(`${line}\n`)
const problems: string[] = []
const fail = (line: string) => { problems.push(line); log(`FAIL  ${line}`) }
const ok = (line: string) => log(`ok    ${line}`)
const warn = (line: string) => log(`WARN  ${line}`)

function run(cmd: string, args: string[]): { status: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" })
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

interface Asset { name: string; url: string; apiUrl: string }

const dir = dirFlag >= 0 ? argv[dirFlag + 1] : mkdtempSync(path.join(tmpdir(), `aquilla-${tag}-`))
if (dirFlag < 0) {
  log(`downloading ${tag} to ${dir}`)
  execFileSync("gh", ["release", "download", tag, "-D", dir, "--clobber"], { cwd: root, stdio: "inherit" })
}
// `--dir` may carry the asset list too (assets.json, as `gh release view
// --json assets` prints it): the release workflow stages a draft's files that
// way so this job needs no token that can see drafts.
const staged = path.join(dir, "assets.json")
const assets = JSON.parse(
  existsSync(staged)
    ? readFileSync(staged, "utf8")
    : execFileSync("gh", ["release", "view", tag, "--json", "assets"], { cwd: root, encoding: "utf8" }),
) as { assets: Asset[] }

// 1. The feed carries every platform, at this version.
const manifestPath = path.join(dir, "latest.json")
if (!existsSync(manifestPath)) {
  fail("the release has no latest.json: no installed app can see it")
  process.exit(1)
}
const manifest: UpdaterManifest = parseUpdaterManifest(readFileSync(manifestPath, "utf8"))
for (const p of manifestProblems(manifest, tag)) fail(p)
if (problems.length === 0) ok(`latest.json is ${manifest.version} with every required platform`)

// 2. Every update file is signed by the key the shell trusts.
const pubkey = (JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")) as { plugins: { updater: { pubkey: string } } }).plugins.updater.pubkey
const fileFor = (key: string): string | null => {
  const entry = manifest.platforms[key]
  const asset = entry && assets.assets.find((a) => a.apiUrl === entry.url || a.url === entry.url)
  return asset ? path.join(dir, asset.name) : null
}
const verified = new Map<string, boolean>()
for (const [key, entry] of Object.entries(manifest.platforms)) {
  const file = fileFor(key)
  if (!file || !existsSync(file)) { fail(`${key}: latest.json points at a file the release does not have`); continue }
  if (!verified.has(file)) verified.set(file, verifyUpdaterSignature(readFileSync(file), entry.signature, pubkey))
  if (verified.get(file)) ok(`${key}: ${path.basename(file)} is signed by the updater key`)
  else fail(`${key}: ${path.basename(file)} fails the updater signature check, so apps would refuse it`)
}

// 3. This OS's build installs and starts.
async function staysUp(cmd: string, args: string[], what: string): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "aquilla-verify-home-"))
  // A fresh HOME keeps the run away from any real profile on a developer's machine.
  const child = spawn(cmd, args, { env: { ...process.env, HOME: home }, stdio: "ignore" })
  let exit: number | null | undefined
  let spawnError: string | undefined
  child.on("exit", (code) => { exit = code })
  child.on("error", (e) => { spawnError = e.message })
  await new Promise((r) => setTimeout(r, ALIVE_MS))
  if (spawnError) fail(`${what} could not be started: ${spawnError}`)
  else if (exit !== undefined) fail(`${what} exited with code ${exit} within ${ALIVE_MS / 1000} s of starting`)
  else ok(`${what} was still running after ${ALIVE_MS / 1000} s`)
  if (exit === undefined && child.pid) {
    if (process.platform === "win32") run("taskkill", ["/T", "/F", "/PID", String(child.pid)])
    else child.kill("SIGKILL")
  }
}

const find = (base: string, test: (name: string) => boolean): string | null => {
  for (const name of readdirSync(base)) {
    const full = path.join(base, name)
    if (test(name)) return full
    if (statSync(full).isDirectory() && !name.endsWith(".app")) {
      const inner = find(full, test)
      if (inner) return inner
    }
  }
  return null
}

function macApp(key: string): string | null {
  const archive = fileFor(key)
  if (!archive || !existsSync(archive)) return null
  const out = mkdtempSync(path.join(tmpdir(), `aquilla-${key}-`))
  if (run("tar", ["-xzf", archive, "-C", out]).status !== 0) { fail(`${key}: the update archive does not extract`); return null }
  const app = find(out, (n) => n.endsWith(".app"))
  if (!app) { fail(`${key}: the update archive holds no .app`); return null }
  const codesign = run("codesign", ["--verify", "--deep", "--strict", app])
  if (codesign.status === 0) ok(`${key}: code signature is intact`)
  else fail(`${key}: codesign rejects the app: ${codesign.out.trim()}`)
  const gatekeeper = run("spctl", ["--assess", "--type", "execute", "-vv", app])
  if (gatekeeper.status === 0 && /Notarized Developer ID/.test(gatekeeper.out)) ok(`${key}: Gatekeeper accepts it as notarized`)
  else fail(`${key}: Gatekeeper would block the app: ${gatekeeper.out.trim()}`)
  return app
}

async function launchThisOs(): Promise<void> {
  if (process.platform === "darwin") {
    const mine = process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64"
    const other = mine === "darwin-aarch64" ? "darwin-x86_64" : "darwin-aarch64"
    macApp(other) // signatures only: this machine cannot be both architectures
    const app = macApp(mine)
    if (!app) return
    const exe = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", path.join(app, "Contents/Info.plist")]).out.trim()
    await staysUp(path.join(app, "Contents/MacOS", exe), [], `${mine}: the app`)
  } else if (process.platform === "win32") {
    const setup = fileFor("windows-x86_64")
    if (!setup || !existsSync(setup)) return
    const sig = run("powershell", ["-NoProfile", "-Command", `(Get-AuthenticodeSignature '${setup}').Status`]).out.trim()
    // The Windows build is not Authenticode-signed today (no WINDOWS_CERTIFICATE
    // secret), so this reports the state and does not fail on it.
    if (sig === "Valid") ok("windows-x86_64: installer has a valid Authenticode signature")
    else warn(`windows-x86_64: installer Authenticode status is ${sig}; Windows will show a SmartScreen warning`)
    const install = run(setup, ["/S"])
    if (install.status !== 0) { fail(`windows-x86_64: silent install exited ${install.status}`); return }
    const base = path.join(process.env.LOCALAPPDATA ?? "", "Aquilla")
    const exe = existsSync(base) ? find(base, (n) => n.endsWith(".exe") && !/uninstall/i.test(n)) : null
    if (!exe) { fail(`windows-x86_64: nothing was installed under ${base}`); return }
    ok(`windows-x86_64: installed ${exe}`)
    await staysUp(exe, [], "windows-x86_64: the installed app")
  } else {
    const appImage = fileFor("linux-x86_64")
    if (!appImage || !existsSync(appImage)) return
    run("chmod", ["+x", appImage])
    await staysUp("xvfb-run", ["-a", appImage, "--appimage-extract-and-run"], "linux-x86_64: the AppImage")
  }
}

if (launch && problems.length === 0) await launchThisOs()

if (problems.length > 0) {
  log(`\n${tag} is NOT safe to promote: ${problems.length} problem(s).`)
  process.exit(1)
}
log(`\n${tag} passed${launch ? ` (update files for every platform; install and start on ${process.platform})` : " (update files for every platform)"}.`)
