import type {
  CellCommitInput,
  CellValidateInput,
  SelfValidationResult,
} from "@/lib/sync/events-emit"

/**
 * A test double for `emitTargetCellCommitAndValidate` built from a file's
 * mocked `emitTargetCellCommit` and `emitCellValidate`, so component tests
 * keep asserting WHICH commit and WHICH validation an edit asks for. That the
 * real pair lands in one outbox write is `events-emit.commit-and-validate.test.ts`.
 */
export function commitAndValidateDouble(
  commit: (input: CellCommitInput) => Promise<string>,
  validate: (input: CellValidateInput) => Promise<string>,
) {
  return async (
    commitInput: CellCommitInput,
    validateInput: Omit<CellValidateInput, "editEventId">,
  ): Promise<{ eventId: string; validation: SelfValidationResult }> => {
    const eventId = await commit(commitInput)
    try {
      const validated = await validate({ ...validateInput, editEventId: eventId })
      return { eventId, validation: { ok: true, eventId: validated } }
    } catch (error) {
      return { eventId, validation: { ok: false, error } }
    }
  }
}
