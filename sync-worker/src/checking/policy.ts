import { z } from "zod"

export const unitSchema = z.object({ fileId: z.string().min(1).max(256), cellId: z.string().min(1).max(256) }).strict()
export const createCheckingSchema = z.object({
  projectId: z.string().min(1).max(256),
  title: z.string().trim().min(1).max(120),
  role: z.enum(["viewer", "commenter", "reviewer"]),
  units: z.array(unitSchema).min(1).max(2000),
  pin: z.string().regex(/^\d{4,12}$/).optional(),
}).strict()
export const joinCheckingSchema = z.object({
  name: z.string().trim().min(1).max(80),
  pin: z.string().max(12).optional(),
}).strict()
export type CheckingUnit = z.infer<typeof unitSchema>
export function inCheckingScope(units: CheckingUnit[], fileId: string, cellId: string): boolean {
  return units.some(unit => unit.fileId === fileId && unit.cellId === cellId)
}
/** Guests only create new cell feedback. No forged replies, foreign edits,
 * validations, project comments, or content mutation can cross this gateway. */
export const feedbackSchema = z.object({
  id: z.string().uuid(),
  schemaVersion: z.literal(1),
  projectId: z.string(), fileId: z.string(),
  cellId: z.string().nullable().optional(),
  parentId: z.null().optional(),
  kind: z.literal("comment.create"),
  author: z.string(),
  clientTs: z.number().int().nonnegative(),
  payload: z.object({
    commentId: z.string().uuid(),
    scope: z.object({ kind: z.literal("cell"), fileId: z.string(), cellId: z.string() }).strict(),
    body: z.string().trim().min(1).max(10000),
    parentCommentId: z.null().optional(),
    createdForTranslated: z.string().nullable().optional(),
  }).strict(),
}).strict()
