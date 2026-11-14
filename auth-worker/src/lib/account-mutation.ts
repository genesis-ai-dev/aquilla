// Serialize login-method changes with email changes on the stable account ID.
// The mutation runs in a NEW statement after acquiring the row lock, so it sees
// links committed by a concurrent transaction before we acquired that lock.
export async function accountMutation<T>(db: AquillaDb, userId: number, work: (tx: AquillaDb) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new Error("Account changes require transactions")
  return db.transaction(async tx => {
    await tx.prepare("SELECT id FROM users WHERE id=? FOR UPDATE").bind(userId).first()
    return work(tx)
  })
}
