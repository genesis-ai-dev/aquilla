// What the Bible document (AQU-2559) knows about each cell's value while the
// translator types, saves run, and colleagues' edits arrive.
//
// Per cell there are up to three values: what the store holds, what the
// document shows, and what is on its way to the store. The ledger keeps:
//   - `synced`: the store value the document reflects (or the value being
//     saved, from the moment its save starts);
//   - `unsaved`: a value typed here that the store does not have yet.
// Everything the editor decides (repaint this cell? save it? is it clean?)
// is a question to this ledger, so the rules live in one place.

export class SaveLedger {
  private synced = new Map<string, string>()
  private unsaved = new Map<string, string>()
  private failed = new Set<string>()

  /** The document was laid out again from these store values. Unsaved words
   *  survive for cells that still exist. */
  reset(values: Iterable<readonly [string, string]>): void {
    this.synced = new Map(values)
    for (const id of [...this.unsaved.keys()]) {
      if (!this.synced.has(id)) {
        this.unsaved.delete(id)
        this.failed.delete(id)
      }
    }
  }

  /** The translator's edit left the cell holding `value`. */
  edited(cellId: string, value: string): void {
    if (this.synced.get(cellId) === value) {
      this.unsaved.delete(cellId)
      this.failed.delete(cellId)
    } else this.unsaved.set(cellId, value)
  }

  /** The store holds `value` for the cell. True when the document must be
   *  repainted to show it: the value is news, and nothing typed here is
   *  waiting to replace it. */
  storeHolds(cellId: string, value: string): boolean {
    if (this.unsaved.has(cellId) || this.synced.get(cellId) === value) return false
    this.synced.set(cellId, value)
    return true
  }

  /** What the document should show for the cell, given the store's value. */
  shown(cellId: string, storeValue: string): string {
    return this.unsaved.get(cellId) ?? storeValue
  }

  pending(): Array<[string, string]> {
    return [...this.unsaved]
  }

  /**
   * A save of `value` is starting. From now the value counts as the store's,
   * so words typed (or undone) while the save runs are compared against it
   * and wait for a save of their own. Call the returned function when the
   * save settles.
   */
  begin(cellId: string, value: string): (ok: boolean) => void {
    const previous = this.synced.get(cellId)
    this.synced.set(cellId, value)
    return (ok) => {
      if (ok) {
        if (this.unsaved.get(cellId) === value) this.unsaved.delete(cellId)
        this.failed.delete(cellId)
        return
      }
      if (previous === undefined) this.synced.delete(cellId)
      else this.synced.set(cellId, previous)
      this.failed.add(cellId)
    }
  }

  snapshot(): { unsaved: ReadonlyMap<string, string>; failed: number } {
    return { unsaved: new Map(this.unsaved), failed: this.failed.size }
  }
}
