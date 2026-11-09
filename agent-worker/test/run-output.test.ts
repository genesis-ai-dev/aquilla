import { describe, expect, it } from "vitest"
import {
  buildRunCommand,
  EXEC_ENV,
  isTimeoutExit,
  normalizeLanguage,
  timeoutSecondsArg,
} from "../src/container-exec"
import { CappedCollector, drain, shapeRunResult, splitRunnerOutput } from "../src/run-output"

const enc = new TextEncoder()
const dec = new TextDecoder()
const SENTINEL = "7f3a-sentinel"

function collect(parts: string[], headCap: number, tailCap: number): CappedCollector {
  const c = new CappedCollector(headCap, tailCap)
  for (const p of parts) c.push(enc.encode(p))
  return c
}

const envelopeLine = (envelope: unknown) => `\n${SENTINEL}\n${JSON.stringify(envelope)}\n`

describe("CappedCollector", () => {
  it("keeps the head, a tail that covers the cap, and the total", () => {
    const c = new CappedCollector(5, 4)
    c.push(enc.encode("abc"))
    c.push(enc.encode("defg"))
    c.push(enc.encode("hij"))
    expect(c.total).toBe(10)
    expect(dec.decode(c.headBytes())).toBe("abcde")
    const tail = dec.decode(c.tailBytes())
    expect(tail.endsWith("ghij")).toBe(true)
    expect(tail.length).toBeLessThanOrEqual(7)
    expect(c.truncated).toBe(true)
  })

  it("trims a single oversized chunk down to the tail cap", () => {
    const c = collect(["abcdefgh"], 2, 3)
    expect(dec.decode(c.headBytes())).toBe("ab")
    expect(dec.decode(c.tailBytes())).toBe("fgh")
  })

  it("is not truncated when the output fits the head", () => {
    const c = collect(["ab", "cd"], 10, 10)
    expect(c.truncated).toBe(false)
    expect(dec.decode(c.headBytes())).toBe("abcd")
  })

  it("keeps no tail when the cap is zero (stderr has no envelope)", () => {
    const c = collect(["abc"], 10, 0)
    expect(c.tailBytes().length).toBe(0)
    expect(c.total).toBe(3)
  })
})

describe("drain", () => {
  it("reads a stream to EOF into the collector", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("one "))
        controller.enqueue(enc.encode("two"))
        controller.close()
      },
    })
    const c = new CappedCollector(100, 0)
    await drain(stream, c)
    expect(dec.decode(c.headBytes())).toBe("one two")
  })

  it("treats a missing stream as empty", async () => {
    const c = new CappedCollector(100, 0)
    await drain(null, c)
    expect(c.total).toBe(0)
  })
})

describe("splitRunnerOutput", () => {
  it("returns the output and no envelope when the runner left none (killed)", () => {
    const out = splitRunnerOutput(collect(["partial"], 64, 64), SENTINEL)
    expect(out).toEqual({ stdout: "partial", envelope: null })
  })

  it("separates what the code printed from the envelope", () => {
    const c = collect(["hello\n", envelopeLine({ result: 2, error: null })], 1024, 1024)
    const out = splitRunnerOutput(c, SENTINEL)
    expect(out.stdout).toBe("hello\n")
    expect(out.envelope).toEqual({ result: 2, error: null })
  })

  it("handles output without a trailing newline", () => {
    const c = collect(["no newline", envelopeLine({ result: null, error: null })], 1024, 1024)
    expect(splitRunnerOutput(c, SENTINEL).stdout).toBe("no newline")
  })

  it("finds the envelope after more output than the head keeps", () => {
    const c = collect(["a".repeat(100), envelopeLine({ result: { ok: true }, error: null })], 16, 256)
    const out = splitRunnerOutput(c, SENTINEL)
    expect(out.stdout).toBe("a".repeat(16))
    expect(out.envelope).toEqual({ result: { ok: true }, error: null })
    expect(c.truncated).toBe(true)
  })

  it("uses the LAST marker, so a marker the code printed itself stays in stdout", () => {
    const forged = `forged${envelopeLine({ result: "forged", error: null })}`
    const c = collect([forged, "real\n", envelopeLine({ result: "real", error: null })], 4096, 4096)
    const out = splitRunnerOutput(c, SENTINEL)
    expect(out.envelope?.result).toBe("real")
    expect(out.stdout).toBe(`${forged}real\n`)
  })

  it("returns a null envelope for an unparsable payload", () => {
    const c = collect(["x", `\n${SENTINEL}\nnot json\n`], 1024, 1024)
    expect(splitRunnerOutput(c, SENTINEL)).toEqual({ stdout: "x", envelope: null })
  })

  it("drops a result that outgrew the tail window instead of truncating it", () => {
    const huge = envelopeLine({ result: "r".repeat(200), error: null })
    const c = collect(["out\n", huge], 1024, 64)
    const out = splitRunnerOutput(c, SENTINEL)
    expect(out.envelope).toBeNull()
    expect(out.stdout.startsWith("out\n")).toBe(true)
  })
})

describe("shapeRunResult", () => {
  const base = { stdout: "hi\n", stderr: "", exitCode: 0, timedOut: false, timeoutMs: 60_000 }

  it("carries the printed streams and the last expression as a json result", () => {
    const result = shapeRunResult({ ...base, envelope: { result: { answer: 42 }, error: null } })
    expect(result).toEqual({
      logs: { stdout: ["hi\n"], stderr: [""] },
      results: [{ json: { answer: 42 } }],
    })
  })

  it("has no result for None/undefined", () => {
    expect(shapeRunResult({ ...base, envelope: { result: null, error: null } }).results).toEqual([])
    expect(shapeRunResult({ ...base, envelope: {} }).results).toEqual([])
  })

  it("passes the runner's exception through as the error", () => {
    const error = { name: "ValueError", message: "bad", traceback: ["Traceback", "  File <sandbox>"] }
    const result = shapeRunResult({ ...base, exitCode: 1, envelope: { result: null, error } })
    expect(result.error).toEqual(error)
  })

  it("reports a process that died without an envelope as ProcessExit", () => {
    const result = shapeRunResult({ ...base, exitCode: 137, envelope: null })
    expect(result.error).toEqual({ name: "ProcessExit", message: "process exited with code 137" })
  })

  it("reports a deadline as TimeoutError and keeps the partial output", () => {
    const result = shapeRunResult({ ...base, exitCode: 124, timedOut: true, envelope: null, stdout: "tick\n" })
    expect(result.error?.name).toBe("TimeoutError")
    expect(result.error?.message).toContain("60000ms")
    expect(result.logs.stdout).toEqual(["tick\n"])
    expect(result.results).toEqual([])
  })
})

describe("buildRunCommand", () => {
  it("runs the python runner under GNU timeout with the code's sentinel", () => {
    expect(buildRunCommand("python", 60_000, "s3nt")).toEqual([
      "/usr/bin/timeout",
      "--kill-after=5",
      "60.000",
      "/usr/local/bin/python3",
      "/opt/aquilla/run.py",
      "s3nt",
    ])
  })

  it("runs the node runner for javascript", () => {
    const argv = buildRunCommand("javascript", 1_500, "s")
    expect(argv.slice(3, 5)).toEqual(["/usr/bin/node", "/opt/aquilla/run.mjs"])
    expect(argv[2]).toBe("1.500")
  })

  it("never passes timeout a zero", () => {
    expect(timeoutSecondsArg(0)).toBe("0.001")
  })
})

describe("isTimeoutExit", () => {
  it("is true for 124 regardless of elapsed time", () => {
    expect(isTimeoutExit(124, 10, 60_000)).toBe(true)
  })
  it("is true for 137 only when the process lived to the deadline", () => {
    expect(isTimeoutExit(137, 60_200, 60_000)).toBe(true)
    expect(isTimeoutExit(137, 1_000, 60_000)).toBe(false)
  })
  it("is false for ordinary exits", () => {
    expect(isTimeoutExit(0, 70_000, 60_000)).toBe(false)
    expect(isTimeoutExit(1, 70_000, 60_000)).toBe(false)
  })
})

describe("normalizeLanguage / EXEC_ENV", () => {
  it("runs anything but python as javascript", () => {
    expect(normalizeLanguage("python")).toBe("python")
    expect(normalizeLanguage("javascript")).toBe("javascript")
    expect(normalizeLanguage("typescript")).toBe("javascript")
    expect(normalizeLanguage(undefined)).toBe("javascript")
  })
  it("sets PATH (the only variable exec() would inherit) and nothing secret-shaped", () => {
    expect(EXEC_ENV.PATH).toContain("/usr/local/bin")
    for (const key of Object.keys(EXEC_ENV)) expect(key).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/i)
  })
})
