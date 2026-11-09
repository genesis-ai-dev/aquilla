// Aquilla sandbox runner for JavaScript (agent-worker, AQU-AGENT).
//
// One process per `/exec` call. The Durable Object (src/sandbox-do.ts) starts
// `timeout ... node /opt/aquilla/run.mjs <sentinel>` with the agent's code on
// stdin, and this script reproduces what the 0.x Sandbox SDK's interpreter
// returned: the code's stdout/stderr as it ran, the completion value of the
// script (its last expression), and the exception that stopped it. Those last
// two travel as one JSON line after a sentinel the caller chose
// (src/run-output.ts decodes it):
//
//     <everything the code printed>
//     <sentinel>
//     {"result": <JSON value or null>, "error": {"name", "message", "traceback"} | null}
//
// The code runs as a classic script (`vm.runInThisContext`), so `require()`
// is available for Node built-ins but `import` statements are not; a promise
// as the last expression is awaited. Exit code 0 on completion, 1 on a throw.
// Keep this file dependency-free; test/runner.test.ts also runs it with the
// host's node.
import { createRequire } from "node:module"
import vm from "node:vm"

const FILENAME = "<sandbox>"

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}

/** What JSON can carry: round-trip through JSON.stringify, else the value's string form. */
function jsonable(value) {
  if (value === undefined || value === null) return null
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return JSON.parse(text)
  } catch {
    return String(value)
  }
}

function describe(error) {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
      traceback: String(error.stack ?? "").split("\n"),
    }
  }
  return { name: "Error", message: String(error), traceback: [] }
}

async function main() {
  const sentinel = process.argv[2]
  // Hide the sentinel from the code.
  process.argv = [process.argv[0], FILENAME]
  const code = await readStdin()
  // Scripts, not modules: `require()` resolves Node built-ins and /workspace/node_modules.
  globalThis.require = createRequire("/workspace/")

  let envelope
  let exitCode = 0
  try {
    let value = vm.runInThisContext(code, { filename: FILENAME })
    if (value !== null && typeof value === "object" && typeof value.then === "function") {
      value = await value
    }
    envelope = { result: jsonable(value), error: null }
  } catch (error) {
    envelope = { result: null, error: describe(error) }
    exitCode = 1
  }

  await new Promise((resolve) => {
    process.stdout.write(`\n${sentinel}\n${JSON.stringify(envelope)}\n`, () => resolve())
  })
  process.exitCode = exitCode
}

main()
