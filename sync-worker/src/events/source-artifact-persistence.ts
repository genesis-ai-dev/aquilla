export interface SourceArtifactPersistenceInput {
  projectId: string
  fileId: string
  artifactId: string
  bindingId: string
  uploadedByUserId: string
  artifactName: string
  contentType: string
  byteLength: number
  sha256: string
  r2Key: string
  format: string
  bindingRole: 'source' | 'target' | 'support'
  targetLang: string
  memberPath: string
  profileId: string
  profileVersion: string
  fidelity: 'native' | 'verified-recipe' | 'content-only' | 'preserved-only'
  manifest: Record<string, unknown>
  recipe: Record<string, unknown> | null
  origin: 'browser-import' | 'codex-local-migration' | 'codex-gitlab-lfs-migration'
  updateSourceSidecar: boolean
  createdAt: number
}

/**
 * The one persistence contract for browser uploads and trusted migration
 * copies. Keeping all three rows in one returned batch makes binding + sidecar
 * visibility atomic from the database's perspective.
 */
export function buildSourceArtifactPersistenceStatements(
  db: AquillaDb,
  input: SourceArtifactPersistenceInput,
): AquillaStatement[] {
  const statements: AquillaStatement[] = []
  if (input.updateSourceSidecar) {
    statements.push(db.prepare(
      `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT (file_id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         format     = EXCLUDED.format,
         raw_source = NULL,
         r2_key     = EXCLUDED.r2_key,
         size_bytes = EXCLUDED.size_bytes,
         created_at = EXCLUDED.created_at`,
    ).bind(
      input.fileId,
      input.projectId,
      input.format,
      input.r2Key,
      input.byteLength,
      input.createdAt,
    ))
  }
  statements.push(
    db.prepare(
      `INSERT INTO artifacts (
         id, project_id, uploaded_by_user_id, credential_id, name, content_type,
         size_bytes, sha256, r2_key, file_id, kind, metadata
       ) VALUES (?::uuid, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'source', ?::text::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    ).bind(
      input.artifactId,
      input.projectId,
      input.uploadedByUserId,
      input.artifactName,
      input.contentType,
      input.byteLength,
      input.sha256,
      input.r2Key,
      input.fileId,
      JSON.stringify({ origin: input.origin, sourceFormat: input.format }),
    ),
    db.prepare(
      `INSERT INTO artifact_bindings (
         id, project_id, artifact_id, file_id, binding_role, target_lang,
         member_path, profile_id, profile_version, fidelity, manifest, recipe
       ) VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?::text::jsonb, ?::text::jsonb)
       ON CONFLICT (artifact_id, file_id, binding_role, target_lang, member_path)
       DO UPDATE SET
         profile_id = EXCLUDED.profile_id,
         profile_version = EXCLUDED.profile_version,
         fidelity = EXCLUDED.fidelity,
         manifest = EXCLUDED.manifest,
         recipe = EXCLUDED.recipe,
         updated_at = now()`,
    ).bind(
      input.bindingId,
      input.projectId,
      input.artifactId,
      input.fileId,
      input.bindingRole,
      input.targetLang,
      input.memberPath,
      input.profileId,
      input.profileVersion,
      input.fidelity,
      JSON.stringify(input.manifest),
      input.recipe ? JSON.stringify(input.recipe) : null,
    ),
  )
  return statements
}
