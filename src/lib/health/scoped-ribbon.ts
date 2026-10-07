import { buildHealthRibbon, type HealthRibbonInput, type HealthRibbonPoint } from "./health-ribbon"
import { ribbonInputFor, stabilizeRibbonPoints, type RibbonInputCell, type RibbonInputReaders } from "./ribbon-inputs"

/** Lazy display-only ribbon. Health itself remains calculated for all cells. */
export function createScopedRibbonCache() {
  let previousPoints = new Map<string, HealthRibbonPoint>()
  type Entry = { version: number; health: number | undefined; examples: unknown; input: HealthRibbonInput }
  type Window = { inputs: HealthRibbonInput[]; points: Map<string, HealthRibbonPoint> }
  let previousEntries = new Map<string, Entry>()
  let previousWindows = new Map<string, Window>()
  return {
    read<C extends RibbonInputCell>(
      ids: readonly string[],
      indexById: ReadonlyMap<string, number>,
      readers: RibbonInputReaders<C>,
    ): Pick<ReadonlyMap<string, HealthRibbonPoint>, "get"> {
      const previous = previousPoints
      const points = new Map<string, HealthRibbonPoint>()
      previousPoints = points
      const oldEntries = previousEntries
      const oldWindows = previousWindows
      const entries = new Map<string, Entry>()
      const windows = new Map<string, Window>()
      previousEntries = entries
      previousWindows = windows
      const inputs = new Map<number, HealthRibbonInput>()
      const inputAt = (index: number): HealthRibbonInput => {
        let input = inputs.get(index)
        if (!input) {
          const id = ids[index]
          const version = readers.getCellVersion(id)
          const health = readers.health(id)
          const examples = readers.examples(id)
          const before = oldEntries.get(id)
          const derived = before && before.version === version && before.health === health && before.examples === examples
            ? before.input : ribbonInputFor(id, readers.getCell(id), readers)
          input = before && before.input.scope === derived.scope && before.input.stage === derived.stage
            && before.input.rawScore === derived.rawScore && before.input.evidenceWeight === derived.evidenceWeight
            ? before.input : derived
          entries.set(id, { version, health, examples, input })
          inputs.set(index, input)
        }
        return input
      }
      const scopeStart = (index: number) => {
        const scope = inputAt(index).scope
        while (index > 0 && inputAt(index - 1).scope === scope) index--
        return index
      }
      const scopeEnd = (index: number) => {
        const scope = inputAt(index).scope
        while (index + 1 < ids.length && inputAt(index + 1).scope === scope) index++
        return index
      }
      return {
        get(id) {
          if (points.has(id)) return points.get(id)
          const index = indexById.get(id)
          if (index === undefined || ids[index] !== id) return undefined
          const start = scopeStart(index)
          const end = scopeEnd(index)
          // Smoothing cannot cross a scope boundary. The displayed seam does
          // blend with the adjacent point, whose score needs its WHOLE scope.
          // Include both neighboring scopes, not an arbitrary pixel/row pad.
          const paddedStart = start > 0 ? scopeStart(start - 1) : start
          const paddedEnd = end + 1 < ids.length ? scopeEnd(end + 1) : end
          const window: HealthRibbonInput[] = []
          for (let i = paddedStart; i <= paddedEnd; i++) window.push(inputAt(i))
          const before = oldWindows.get(ids[start])
          const computed = before && before.inputs.length === window.length
            && window.every((input, i) => input === before.inputs[i])
            ? before.points : stabilizeRibbonPoints(previous, buildHealthRibbon(window))
          windows.set(ids[start], { inputs: window, points: computed })
          // Outer scopes have incomplete seams; cache only the requested scope.
          for (let i = start; i <= end; i++) points.set(ids[i], computed.get(ids[i])!)
          return points.get(id)
        },
      }
    },
  }
}
