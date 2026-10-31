/** Which `risk:*` labels to add and remove so the PR carries exactly its areas. Never touches other labels. */
export function labelDelta(current: string[], areas: string[]): { add: string[]; remove: string[] }
