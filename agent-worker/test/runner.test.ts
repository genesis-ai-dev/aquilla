import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { RunnerEnvelope } from "../src/run-output"

// The runners the Durable Object execs inside the container (runner/*), run
// here with the host's interpreters: they are plain scripts with no
// dependencies, so what they print on the host is what they print in the image.
const PY = fileURLToPath(new URL("../runner/run.py", import.meta.url).href)
const JS = fileURLToPath(new URL("../runner/run.mjs", import.meta.url).href)
const SENTINEL = "test-sentinel-0b1e"
const hasPython = spawnSync("python3", ["--version"]).status === 0

interface Run {
  status: number | null
  stdout: string
  stderr: string
  envelope: RunnerEnvelope | null
}

function parse(r: SpawnSyncReturns<string>): Run {
  const marker = `\n${SENTINEL}\n`
  const at = r.stdout.lastIndexOf(marker)
  if (at < 0) return { status: r.status, stdout: r.stdout, stderr: r.stderr, envelope: null }
  const line = r.stdout.slice(at + marker.length).split("\n")[0]
  return {
    status: r.status,
    stdout: r.stdout.slice(0, at),
    stderr: r.stderr,
    envelope: JSON.parse(line) as RunnerEnvelope,
  }
}

const python = (code: string) => parse(spawnSync("python3", [PY, SENTINEL], { input: code, encoding: "utf8" }))
const node = (code: string) => parse(spawnSync(process.execPath, [JS, SENTINEL], { input: code, encoding: "utf8" }))

describe.skipIf(!hasPython)("runner/run.py", () => {
  it("prints as it runs and reports the last expression's value", () => {
    const r = python("print('hello')\n1 + 1\n")
    expect(r.status).toBe(0)
    expect(r.stdout).toBe("hello\n")
    expect(r.envelope).toEqual({ result: 2, error: null })
  })

  it("passes JSON containers through and keeps output without a trailing newline intact", () => {
    const r = python("print('no newline', end='')\nx = {'a': [1, 2], 'b': (3, 4)}\nx")
    expect(r.stdout).toBe("no newline")
    expect(r.envelope?.result).toEqual({ a: [1, 2], b: [3, 4] })
  })

  it("has no result when the code ends in a statement", () => {
    expect(python("x = 1\n").envelope).toEqual({ result: null, error: null })
  })

  it("falls back to repr for values JSON cannot carry", () => {
    expect(python("float('nan')").envelope?.result).toBe("nan")
    expect(python("class A: pass\nA()").envelope?.result).toMatch(/^<__main__\.A object/)
    expect(python("{1: 'a'}").envelope?.result).toEqual({ "1": "a" })
  })

  it("reports an exception with a traceback that starts in the agent's code", () => {
    const r = python("def f():\n    raise ValueError('bad')\nf()\n")
    expect(r.status).toBe(1)
    expect(r.envelope?.error?.name).toBe("ValueError")
    expect(r.envelope?.error?.message).toBe("bad")
    const traceback = r.envelope?.error?.traceback ?? []
    expect(traceback.join("\n")).toContain('File "<sandbox>"')
    expect(traceback.join("\n")).not.toContain("run.py")
    expect(r.stderr).toBe("")
  })

  it("reports a syntax error without running anything", () => {
    const r = python("print('before')\ndef f(:\n")
    expect(r.status).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.envelope?.error?.name).toBe("SyntaxError")
  })

  it("honours sys.exit codes", () => {
    const r = python("import sys\nprint('x')\nsys.exit(3)\n")
    expect(r.status).toBe(3)
    expect(r.stdout).toBe("x\n")
    expect(r.envelope?.error?.name).toBe("SystemExit")
    expect(python("import sys\nsys.exit(0)\n").status).toBe(0)
    const msg = python("import sys\nsys.exit('goodbye')\n")
    expect(msg.status).toBe(1)
    expect(msg.stderr).toContain("goodbye")
  })

  it("hides the sentinel from argv and gives the code an empty stdin", () => {
    expect(python("import sys\nsys.argv").envelope?.result).toEqual(["<sandbox>"])
    expect(python("import sys\nsys.stdin.read()").envelope?.result).toBe("")
  })

  it("keeps stderr as the code's own stream", () => {
    const r = python("import sys\nprint('warn', file=sys.stderr)\n")
    expect(r.stderr).toBe("warn\n")
    expect(r.status).toBe(0)
  })
})

describe("runner/run.mjs", () => {
  it("prints as it runs and reports the script's completion value", () => {
    const r = node("console.log('hello'); 1 + 1")
    expect(r.status).toBe(0)
    expect(r.stdout).toBe("hello\n")
    expect(r.envelope).toEqual({ result: 2, error: null })
  })

  it("awaits a promise left as the last expression", () => {
    expect(node("Promise.resolve({ a: 1 })").envelope?.result).toEqual({ a: 1 })
  })

  it("has no result for undefined and stringifies what JSON cannot carry", () => {
    expect(node("const x = 1").envelope).toEqual({ result: null, error: null })
    expect(node("10n ** 20n").envelope?.result).toBe("100000000000000000000")
    expect(node("() => 1").envelope?.result).toBe("() => 1")
  })

  it("reports a throw with name, message and stack", () => {
    const r = node("throw new TypeError('bad')")
    expect(r.status).toBe(1)
    expect(r.envelope?.error?.name).toBe("TypeError")
    expect(r.envelope?.error?.message).toBe("bad")
    // V8 prefixes a vm script's stack with the source line and caret.
    expect(r.envelope?.error?.traceback?.join("\n")).toContain("TypeError: bad")
  })

  it("reports a rejected promise as the error", () => {
    const r = node("Promise.reject(new Error('later'))")
    expect(r.status).toBe(1)
    expect(r.envelope?.error?.message).toBe("later")
  })

  it("resolves Node built-ins through require()", () => {
    expect(node("require('node:path').posix.join('a', 'b')").envelope?.result).toBe("a/b")
  })

  it("hides the sentinel from argv", () => {
    const r = node("process.argv.slice(1)")
    expect(r.envelope?.result).toEqual(["<sandbox>"])
  })
})
