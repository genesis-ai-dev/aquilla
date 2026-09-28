/**
 * Annotated tag message for a production release tag. Throws when any
 * argument is empty.
 */
export function generateTagMessage(tag: string, branch: string, commitSha: string): string
