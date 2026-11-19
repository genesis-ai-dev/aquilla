#!/usr/bin/env tsx
/**
 * AQU-2654 — what the Transcribe view costs per action: React commits,
 * component renders, `TranscribeRow` renders, long tasks and requests.
 *
 *   pnpm dev                                              # the local stack
 *   pnpm exec tsx scripts/perf/transcribe-probe.ts        # build, serve, seed, measure
 *   pnpm exec tsx scripts/perf/transcribe-probe.ts --no-build --label after
 *
 * A stand-alone probe, to be folded into `interaction.ts` as a scenario. Each
 * run seeds its own small project (one file, 30 lines with a real recorded
 * take each), because a run transcribes them and a second run over the same
 * project would find nothing left to do.
 *
 * Speech recognition and the AI cleanup are answered IN THE PAGE (a `fetch`
 * stand-in installed before the app boots): ASR after a fixed delay, the
 * cleanup as a real `text/event-stream` body written one token at a time. So
 * the app's own code runs unchanged — the clip is fetched and decoded, the
 * reply is read off a stream, every save goes through the outbox to the local
 * sync-worker — and the timings do not depend on a model.
 *
 * Counts are the contract (see lib/interaction-probe.ts); timings ride along.
 */

import { parseArgs } from "node:util"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { v7 as uuidv7 } from "uuid"
import type { Locator, Page } from "@playwright/test"
import { devLogin, mintSyncToken, postEvents, readCellsPage, DEFAULT_TARGET, type PerfTarget, type RawEventInput } from "./lib/client"
import { readHandle } from "./lib/fixture-handle"
import {
  INTERACTION_INIT_SCRIPT,
  READ_PROBE,
  RESET_PROBE,
  rendersOf,
  routeKey,
  summarizePhase,
  type PhaseResult,
  type ProbeReading,
  type RequestTally,
} from "./lib/interaction-probe"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const DIST_DIR = path.join(REPO_ROOT, ".perf", "transcribe-dist")
const PREVIEW_PORT = 4178
const CLOUD_CHROMIUM = "/opt/pw-browsers/chromium"
const ROW = '[data-testid="transcribe-row"]'
const ROWS = 30
/** Stall watchdog, not a target (AGENTS.md rule 15). */
const READY_TIMEOUT_MS = 600_000

const log = (line: string) => console.log(`[transcribe-probe] ${line}`)

/**
 * The stand-in for the two model routes. ASR answers a 40-word line after
 * `asrDelayMs`; the cleanup streams its rewrite of the line it was sent, one
 * word every `tokenMs`, then the result frame. Counters are read back so the
 * report can say how many of each were asked for.
 */
const STUB_MODELS = `
(() => {
  const real = window.fetch.bind(window);
  const stub = { asr: 0, cleanup: 0, status: 0, asrDelayMs: 150, tokenMs: 25 };
  window.__transcribeStub = stub;
  const WORDS = 'nilikuwa nikienda sokoni na mama yangu jana asubuhi mapema sana kabla jua halijachomoza na tulikutana na rafiki wa zamani njiani akatuambia habari za kijiji chetu kwamba mvua imenyesha sana mwaka huu na mashamba yote yamejaa mahindi mengi kuliko kawaida'.split(' ');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (url.includes('/api/v1/audio/transcriptions/status')) { stub.status++; return json({ state: 'ready' }); }
    if (url.includes('/api/v1/audio/transcriptions/warm')) return json({});
    if (url.includes('/api/v1/audio/transcriptions')) {
      const n = ++stub.asr;
      await sleep(stub.asrDelayMs);
      const words = WORDS.concat(['mstari', String(n)]);
      return json({ text: words.join(' '), model: 'omni-fast', granularity: 'word',
        chunks: words.map((text, i) => ({ text, start: i * 0.03, end: i * 0.03 + 0.025 })) });
    }
    if (url.includes('/api/v1/ai/transcript-cleanup')) {
      stub.cleanup++;
      const heard = String(JSON.parse(init.body).heard || '');
      const out = heard.split(/\\s+/).map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : i % 6 === 3 ? w + 'ni' : w));
      const text = out.join(' ') + '.';
      const changes = out.filter((w, i) => i === 0 || i % 6 === 3).length + 1;
      const enc = new TextEncoder();
      const body = new ReadableStream({
        async start(controller) {
          const tokens = text.split(' ');
          for (let i = 0; i < tokens.length; i++) {
            await sleep(stub.tokenMs);
            controller.enqueue(enc.encode('event: delta\\ndata: ' + JSON.stringify({ add: (i ? ' ' : '') + tokens[i] }) + '\\n\\n'));
          }
          controller.enqueue(enc.encode('event: result\\ndata: ' + JSON.stringify({ model: 'probe', result: { kind: 'ok', text, notes: [], changes } }) + '\\n\\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return real(input, init);
  };
})();
`

/**
 * What preparing one clip for hosted speech recognition costs the main thread,
 * step by step: the steps `audioBytesToWhisperPcm` and
 * `buildTranscriptionRequest` take (decode into a 16 kHz context, copy the
 * window out, quantise to PCM16, base64 for the JSON body), on a clip of
 * `seconds`. The decode itself runs off the main thread; the steps after it do
 * not. The base64 step is timed both ways: by hand, as it was, and through
 * the engine's encoder, as `base64Of` does it now. Returns milliseconds per
 * step, under the page's CPU throttle.
 */
const CLIP_PREP_COST = `
(async (seconds) => {
  const rate = 48000, n = Math.floor(seconds * rate);
  const wav = new ArrayBuffer(44 + n * 2); const v = new DataView(wav);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 20) * 9000), true);
  const t0 = performance.now();
  const ctx = new AudioContext({ sampleRate: 16000 });
  const audio = await ctx.decodeAudioData(wav); void ctx.close();
  const t1 = performance.now();
  const pcm = new Float32Array(audio.length); audio.copyFromChannel(pcm, 0, 0);
  const t2 = performance.now();
  const data = new ArrayBuffer(pcm.length * 2); const dv = new DataView(data);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), true);
  const t3 = performance.now();
  const bytes = new Uint8Array(await new Blob([new ArrayBuffer(44), data]).arrayBuffer());
  const t4 = performance.now();
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const body = JSON.stringify({ input_audio: { data: btoa(binary), format: 'wav' } });
  const t5 = performance.now();
  // The same body through the engine's own encoder (base64Of in transcription-request.ts).
  const engineBody = bytes.toBase64 ? JSON.stringify({ input_audio: { data: bytes.toBase64(), format: 'wav' } }) : '';
  const t6 = performance.now();
  return { decodeWaitMs: Math.round(t1 - t0), copyMs: Math.round(t2 - t1), quantiseMs: Math.round(t3 - t2), base64ByHandMs: Math.round(t5 - t4),
    base64EngineMs: engineBody ? Math.round(t6 - t5) : -1, sameBody: Number(engineBody === body), bodyKb: Math.round(body.length / 1024) };
})
`

// ── fixture ────────────────────────────────────────────────────────────────

/** A mono 16-bit PCM WAV with a swell (e2e/helpers/seed-audio.ts::toneWav). */
function toneWav(seconds: number, rate = 16000): Uint8Array<ArrayBuffer> {
  const n = Math.floor(seconds * rate)
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ")
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const env = Math.sin((Math.PI * i) / n)
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * env * 12000), true)
  }
  return new Uint8Array(buf)
}

interface Fixture { projectId: string; fileId: string; lane: string | undefined; cellIds: string[] }

async function seedFixture(target: PerfTarget, label: string): Promise<Fixture> {
  const handlePath = path.join(REPO_ROOT, ".perf", `transcribe-probe-${label}-handle.json`)
  const seeded = spawnSync(
    "pnpm",
    ["exec", "tsx", "scripts/perf/seed-big-bible.ts", "--books", "1", "--cells", "60", "--history", "0",
      "--name", `Transcribe perf (${label} ${new Date().toISOString().slice(11, 19)})`, "--handle", handlePath],
    { cwd: REPO_ROOT, stdio: "inherit" },
  )
  if (seeded.status !== 0) throw new Error("seeding failed — is the dev stack running (pnpm dev)?")
  const handle = readHandle(handlePath)
  const file = handle.files[0]
  const lane = handle.lanes.find((l) => l.role === "target")?.legacyTag ?? undefined
  const session = await devLogin(target)
  const token = await mintSyncToken(target, session.jwt, handle.projectId, file.id)
  const page = await readCellsPage(target, token, handle.projectId, file.id, { limit: 200, side: "source" })
  const cellIds = [...new Set(page.cells.map((c) => c.cellId))].slice(0, ROWS)
  if (cellIds.length < ROWS) throw new Error(`the seeded file has ${cellIds.length} cells; ${ROWS} are needed`)
  const wav = toneWav(4)
  const events: RawEventInput[] = []
  for (const cellId of cellIds) {
    const audioId = randomUUID()
    const put = await fetch(`${target.syncBase}/audio/${handle.projectId}/${file.id}/${audioId}.wav`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "audio/wav" },
      body: new Blob([wav], { type: "audio/wav" }),
    })
    if (!put.ok) throw new Error(`audio upload failed: HTTP ${put.status} — ${await put.text()}`)
    const attach: RawEventInput = {
      id: uuidv7(), schemaVersion: 1, kind: "cell.audio.attach", projectId: handle.projectId, fileId: file.id, cellId,
      parentId: null, author: session.username, clientTs: Date.now(),
      payload: { audioId, url: `frontier-audio://${audioId}.wav`, slot: "recording", mimeType: "audio/wav", durationMs: 4000, ...(lane ? { targetLang: lane } : {}) },
    }
    events.push(attach, { ...attach, id: uuidv7(), kind: "cell.audio.select", payload: { audioId, slot: "recording", ...(lane ? { targetLang: lane } : {}) } })
  }
  await postEvents(target, token, events)
  log(`seeded project ${handle.projectId}: ${ROWS} lines with a 4 s take each`)
  return { projectId: handle.projectId, fileId: file.id, lane, cellIds }
}

/**
 * What the server holds once the run is over: every row's words, the edit
 * typed into one row and the cleanup of another. The view no longer flushes or
 * reads back after a write, so this is the check that its writes still land.
 */
async function verifySaved(target: PerfTarget, fixture: Fixture): Promise<Record<string, number>> {
  const session = await devLogin(target)
  const token = await mintSyncToken(target, session.jwt, fixture.projectId, fixture.fileId)
  const lane = fixture.lane === undefined ? "" : `?lane=${encodeURIComponent(fixture.lane)}`
  const res = await fetch(
    `${target.syncBase}/api/v1/projects/${fixture.projectId}/files/${fixture.fileId}/audio-attachments${lane}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new Error(`reading the saved takes failed: HTTP ${res.status}`)
  const body = (await res.json()) as {
    cells: Record<string, { attachments: Record<string, { asrText?: string | null; transcriptAi?: unknown }>; audioTimings: Record<string, Array<{ word: string }>> }>
  }
  const row = (i: number) => {
    const entry = body.cells[fixture.cellIds[i]]
    const first = Object.entries(entry?.attachments ?? {})[0]
    const audioId = first?.[0] ?? ""
    const attachment = first?.[1]
    return { heard: attachment?.asrText ?? "", ai: Boolean(attachment?.transcriptAi), text: (entry?.audioTimings[audioId] ?? []).map((w) => w.word).join(" ") }
  }
  const rows = fixture.cellIds.map((_, i) => row(i))
  const saved = {
    rowsHeard: rows.filter((r) => r.heard).length,
    rowsWithTranscript: rows.filter((r) => r.text).length,
    editSaved: Number(row(2).text.includes("na zaidi")),
    cleanupSaved: Number(row(6).ai && row(6).text.endsWith(".")),
  }
  log(`on the server afterwards: ${saved.rowsHeard}/${ROWS} rows heard, ${saved.rowsWithTranscript}/${ROWS} with a transcript, `
    + `the typed edit ${saved.editSaved ? "saved" : "MISSING"}, the cleanup ${saved.cleanupSaved ? "saved with its mark" : "MISSING"}`)
  return saved
}

// ── build + serve (as scripts/perf/interaction.ts) ─────────────────────────

function buildApp(target: PerfTarget): void {
  log("building the SPA (production, unminified) → .perf/transcribe-dist")
  const built = spawnSync("pnpm", ["exec", "vite", "build", "--minify", "false", "--outDir", DIST_DIR, "--logLevel", "warn"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_AUTH_BASE: target.authBase,
      VITE_SYNC_WORKER_HOST: new URL(target.syncBase).host,
      VITE_CHAT_BASE: `${target.authBase}/chat`,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=8192",
    },
  })
  if (built.status !== 0) throw new Error("vite build failed")
}

async function servePreview(): Promise<{ base: string; stop: () => void }> {
  const child: ChildProcess = spawn(
    "pnpm",
    ["exec", "vite", "preview", "--outDir", DIST_DIR, "--port", String(PREVIEW_PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: REPO_ROOT, stdio: "ignore", detached: true },
  )
  const base = `http://127.0.0.1:${PREVIEW_PORT}`
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid)
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      if ((await fetch(base)).ok) return { base, stop }
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null) throw new Error(`vite preview exited (${child.exitCode}) — is port ${PREVIEW_PORT} in use?`)
    if (Date.now() > deadline) {
      stop()
      throw new Error("vite preview did not start within 60s")
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

// ── measurement ────────────────────────────────────────────────────────────

interface Recorder {
  begin(): Promise<void>
  /** `settle: false` reads the probe now instead of waiting for the network to go quiet. */
  end(name: string, extra?: Record<string, number>, settle?: boolean): Promise<PhaseResult>
}

function createRecorder(page: Page, appOrigin: string): Recorder {
  let started: Array<{ route: string; request: unknown; at: number }> = []
  let began = Date.now()
  const sizes = new Map<unknown, number>()
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.origin === appOrigin) return // the app's own static assets
    started.push({ route: routeKey(request.method(), url.pathname), request, at: Date.now() })
  })
  page.on("response", (response) => {
    response.body().then((body) => sizes.set(response.request(), body.length), () => {})
  })
  /** No request started for `quietMs`. */
  const settleQuiet = async (quietMs: number, capMs: number) => {
    const t0 = Date.now()
    let seen = started.length
    let lastChange = Date.now()
    while (Date.now() - t0 < capMs) {
      await page.waitForTimeout(150)
      if (started.length !== seen) {
        seen = started.length
        lastChange = Date.now()
      } else if (Date.now() - lastChange >= quietMs) return
    }
  }
  return {
    async begin() {
      started = []
      began = Date.now()
      await page.evaluate(RESET_PROBE)
      await page.evaluate("(() => { const s = window.__transcribeStub; s.asr = 0; s.cleanup = 0; s.status = 0 })()")
    },
    async end(name, extra = {}, settle = true) {
      if (settle) await settleQuiet(2_500, 60_000)
      const reading = (await page.evaluate(READ_PROBE)) as ProbeReading
      if (reading.react.error) throw new Error(`render counter failed: ${reading.react.error}`)
      const stub = (await page.evaluate("window.__transcribeStub")) as { asr: number; cleanup: number; status: number }
      const tally: RequestTally = { count: started.length, bytes: 0, byRoute: {} }
      for (const entry of started) {
        tally.bytes += sizes.get(entry.request) ?? 0
        tally.byRoute[entry.route] = (tally.byRoute[entry.route] ?? 0) + 1
      }
      const firstWrite = started.find((entry) => entry.route === "POST /events")
      return summarizePhase(name, reading, tally, {
        ...extra,
        // How long after the action its write left for the server.
        ...(firstWrite ? { writeSentAfterMs: firstWrite.at - began } : {}),
        transcribeRowRenders: rendersOf(reading, "TranscribeRow"),
        transcribeEditorRenders: rendersOf(reading, "TranscribeEditor"),
        workspaceRenders: rendersOf(reading, "ProjectWorkspace"),
        diffRenders: rendersOf(reading, "TranscriptDiff"),
        asrCalls: stub.asr,
        cleanupCalls: stub.cleanup,
        audioAttachmentReads: Object.entries(tally.byRoute)
          .filter(([route]) => route.includes("/audio-attachments"))
          .reduce((sum, [, count]) => sum + count, 0),
      })
    },
  }
}

async function signIn(page: Page, appBase: string, target: PerfTarget, projectId: string): Promise<void> {
  // The production build has no /__dev/login route, so write the session the
  // way the app stores it (src/lib/frontier/session-store.ts) and let it boot.
  const session = await devLogin(target)
  await page.goto(`${appBase}/login`, { waitUntil: "commit", timeout: READY_TIMEOUT_MS })
  await page.evaluate(
    `(async (s) => {
      const open = indexedDB.open("frontier", 1);
      open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains("session")) open.result.createObjectStore("session"); };
      await new Promise((res, rej) => { open.onsuccess = res; open.onerror = () => rej(open.error); });
      const tx = open.result.transaction("session", "readwrite");
      tx.objectStore("session").put({ active: s.username, sessions: { [s.username]: s } }, "envelope");
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      open.result.close();
      // Open the file in the Transcribe view (src/hooks/useEditorLensPreference.ts).
      localStorage.setItem("aquilla:editorLens:" + ${JSON.stringify(projectId)}, "transcribe");
    })(${JSON.stringify({ jwt: session.jwt, username: session.username, email: `${session.username}@example.com`, createdAt: new Date().toISOString() })})`,
  )
}

/** How many rows show something speech recognition heard. */
const heardCount = (page: Page) =>
  page.evaluate(`document.querySelectorAll('[data-testid="transcribe-heard"]:not([data-heard=""])').length`) as Promise<number>

async function waitFor(what: string, check: () => Promise<boolean>): Promise<number> {
  const t0 = Date.now()
  while (!(await check())) {
    if (Date.now() - t0 > READY_TIMEOUT_MS) throw new Error(`stalled waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return Date.now() - t0
}

/** Step 7's readings, by clip length. */
const clipPrep: Record<string, Record<string, number>> = {}

async function measure(fixture: Fixture, appBase: string, throttle: number, target: PerfTarget): Promise<PhaseResult[]> {
  const { chromium } = await import("@playwright/test")
  const chrome = process.env.PERF_CHROME ?? (existsSync(CLOUD_CHROMIUM) ? CLOUD_CHROMIUM : null)
  const browser = await chromium.launch(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : {})
  const phases: PhaseResult[] = []
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript({ content: INTERACTION_INIT_SCRIPT })
    await context.addInitScript({ content: STUB_MODELS })
    const page = await context.newPage()
    page.on("dialog", (dialog) => void dialog.accept())
    const cdp = await context.newCDPSession(page)
    const recorder = createRecorder(page, new URL(appBase).origin)
    const row = (i: number): Locator => page.locator(ROW).nth(i)
    const record = (phase: PhaseResult) => {
      phases.push(phase)
      log(
        `${phase.name}: ${phase.reactCommits} commits, ${phase.componentRenders} renders `
          + `(${phase.extra.transcribeRowRenders} TranscribeRow, ${phase.extra.workspaceRenders} ProjectWorkspace), `
          + `${phase.longTaskTotalMs}ms blocked in ${phase.longTaskCount} long tasks (longest ${phase.longestTaskMs}ms), `
          + `${phase.requests.count} requests (${phase.extra.audioAttachmentReads} audio-attachments reads)`,
      )
    }

    await signIn(page, appBase, target, fixture.projectId)
    if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle })

    // 1. Open the view: the workspace boots and the rows appear. This is
    //    mostly the workspace's own cost, reported so step 2 is not charged it.
    await recorder.begin()
    const t0 = Date.now()
    await page.goto(`${appBase}/project/${fixture.projectId}/editor/file/${fixture.fileId}`, { waitUntil: "commit", timeout: READY_TIMEOUT_MS })
    await page.locator(ROW).first().waitFor({ state: "visible", timeout: READY_TIMEOUT_MS })
    const firstRowMs = Date.now() - t0
    record(await recorder.end("open the view (to the first row)", { firstRowMs }, false))

    // 2. On the Fast model the view starts the speech-recognition pass by
    //    itself, so what follows IS "Transcribe all" over 30 rows.
    await recorder.begin()
    const t1 = Date.now()
    await waitFor("every row to be transcribed", async () => (await heardCount(page)) >= ROWS)
    const allHeardMs = Date.now() - t1
    await waitFor("the pass to end", async () => (await page.locator('[data-testid="transcribe-progress"]').count()) === 0)
    record(await recorder.end("transcribe all, started by the view (30 rows)", { shownMs: allHeardMs, passEndMs: Date.now() - t1 }))
    // The rows' "just transcribed" overlay lapses 10 s after each row; let it,
    // so it is not charged to the next action.
    await page.waitForTimeout(11_000)

    // 2. Type in a row and save it (Enter).
    const box = row(2).locator('[data-testid="transcribe-transcript"]')
    await box.click()
    // The very end of the text: plain End stops at the end of the wrapped line.
    await page.keyboard.press("Control+End")
    await recorder.begin()
    const typed = " na zaidi"
    await page.keyboard.type(typed, { delay: 60 })
    record(await recorder.end("type 9 characters in a row", {}))
    await recorder.begin()
    let t = Date.now()
    await page.keyboard.press("Enter")
    // The draft is already on screen; what is left is the save itself.
    record(await recorder.end("save the edited row", { totalMs: Date.now() - t }))

    // 3. Erase a row.
    await recorder.begin()
    t = Date.now()
    await row(4).locator('[data-testid="transcribe-clear"]').click()
    const erasedMs = await waitFor("the row to empty", async () =>
      (await row(4).locator('[data-testid="transcribe-heard"]').getAttribute("data-heard")) === "")
    record(await recorder.end("erase a row", { shownMs: erasedMs, totalMs: Date.now() - t }))
    await page.waitForTimeout(11_000)

    // 4. Clean up one row: the reply streams in, one word at a time.
    await recorder.begin()
    t = Date.now()
    await row(6).locator('[data-testid="transcribe-run"]').click()
    const cleanedMs = await waitFor("the cleanup to land", async () =>
      (await row(6).locator('[data-testid="transcribe-cleaned"]').count()) > 0)
    record(await recorder.end("clean up one row (streamed, 42 tokens)", { shownMs: cleanedMs, totalMs: Date.now() - t }))
    await page.waitForTimeout(11_000)

    // 5. "Transcribe all" by hand: erase five more rows (six with step 3's),
    //    then press the button.
    for (const i of [10, 11, 12, 13, 14]) {
      await row(i).locator('[data-testid="transcribe-clear"]').click()
      await waitFor("the row to empty", async () => (await row(i).locator('[data-testid="transcribe-heard"]').getAttribute("data-heard")) === "")
    }
    await page.waitForTimeout(13_000)
    await recorder.begin()
    t = Date.now()
    await page.locator('[data-testid="transcribe-run-all"]').click()
    const sixHeardMs = await waitFor("the six rows to be transcribed", async () => (await heardCount(page)) >= ROWS)
    await waitFor("the pass to end", async () => (await page.locator('[data-testid="transcribe-progress"]').count()) === 0)
    record(await recorder.end("transcribe all (6 rows)", { shownMs: sixHeardMs, passEndMs: Date.now() - t }))

    // 6. Play one row, then another: who re-renders.
    await recorder.begin()
    await row(0).locator("button").filter({ has: page.locator("svg.lucide-play") }).first().click()
    await page.waitForTimeout(600)
    await row(1).locator("button").filter({ has: page.locator("svg.lucide-play") }).first().click()
    await page.waitForTimeout(600)
    record(await recorder.end("play a row, then another", {}))

    // 7. Not an action: what getting one clip ready for hosted speech
    //    recognition costs the main thread, for a take and for the longest
    //    window sent (60 s). The decode waits off-thread; the rest blocks.
    for (const seconds of [4, 15, 60]) {
      const cost = (await page.evaluate(`${CLIP_PREP_COST}(${seconds})`)) as Record<string, number>
      log(`clip prep, ${seconds} s clip: decode ${cost.decodeWaitMs}ms (off-thread), copy ${cost.copyMs}ms, quantise ${cost.quantiseMs}ms, `
        + `base64+JSON by hand ${cost.base64ByHandMs}ms → engine ${cost.base64EngineMs}ms (${cost.bodyKb} KB, same body: ${cost.sameBody === 1})`)
      clipPrep[`${seconds}s`] = cost
    }
    await context.close()
  } finally {
    await browser.close()
  }
  return phases
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { "no-build": { type: "boolean" }, throttle: { type: "string" }, label: { type: "string" }, "app-base": { type: "string" } },
  })
  const throttle = Number(values.throttle ?? 4)
  const label = values.label ?? "run"
  const target = DEFAULT_TARGET
  let stopPreview: (() => void) | null = null
  let appBase = values["app-base"] ?? null
  try {
    if (!appBase) {
      if (!values["no-build"] || !existsSync(path.join(DIST_DIR, "index.html"))) buildApp(target)
      const preview = await servePreview()
      appBase = preview.base
      stopPreview = preview.stop
    }
    const fixture = await seedFixture(target, label)
    const phases = await measure(fixture, appBase, throttle, target)
    const saved = await verifySaved(target, fixture)
    const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim()
    const out = path.join(REPO_ROOT, ".perf", `transcribe-probe-${label}.json`)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify({ harness: "transcribe-probe", sha, at: new Date().toISOString(), throttle, phases, clipPrep, saved }, null, 2))
    log(`report → ${path.relative(REPO_ROOT, out)}`)
    console.log("")
    console.log("action | commits | renders | TranscribeRow | blocked ms (longest) | requests | audio-attachments reads | shown ms")
    for (const p of phases) {
      console.log(
        `${p.name} | ${p.reactCommits} | ${p.componentRenders} | ${p.extra.transcribeRowRenders} | `
          + `${p.longTaskTotalMs} (${p.longestTaskMs}) | ${p.requests.count} | ${p.extra.audioAttachmentReads} | ${p.extra.shownMs ?? p.extra.firstRowMs ?? "-"}`,
      )
    }
    if (saved.rowsHeard !== ROWS || saved.rowsWithTranscript !== ROWS || !saved.editSaved || !saved.cleanupSaved) {
      throw new Error("the server does not hold what the view showed — see the line above")
    }
  } finally {
    stopPreview?.()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exit(1)
})
