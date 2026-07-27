import { assertIdmlReleaseGate } from "./idml-adobe/release-gate"

try {
  const result = await assertIdmlReleaseGate(process.env)
  console.log(`[idml-release-gate] ${result.stage}`)
} catch (error) {
  console.error(`[idml-release-gate] ${(error as Error).message}`)
  process.exitCode = 1
}
