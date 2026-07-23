-- 0067_artifact_binding_project_consistency.sql
--
-- AQU-635 release hardening: artifact_bindings is tenant-scoped by project_id,
-- so both referenced rows must belong to that same project. Runtime checks
-- already enforce this; composite foreign keys make it a database invariant.
-- The redundant composite unique constraints are safe because artifacts.id
-- and files.id are already globally unique primary keys.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'artifacts'::regclass
       AND conname = 'artifacts_id_project_id_key'
  ) THEN
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_id_project_id_key UNIQUE (id, project_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'files'::regclass
       AND conname = 'files_id_project_id_key'
  ) THEN
    ALTER TABLE files
      ADD CONSTRAINT files_id_project_id_key UNIQUE (id, project_id);
  END IF;
END
$$;

-- 0066 created the conventional single-column FK. Replace it in the same
-- transaction; a constraint failure rolls back the entire migration.
ALTER TABLE artifact_bindings
  DROP CONSTRAINT IF EXISTS artifact_bindings_artifact_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'artifact_bindings'::regclass
       AND conname = 'artifact_bindings_artifact_project_fkey'
  ) THEN
    ALTER TABLE artifact_bindings
      ADD CONSTRAINT artifact_bindings_artifact_project_fkey
      FOREIGN KEY (artifact_id, project_id)
      REFERENCES artifacts(id, project_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'artifact_bindings'::regclass
       AND conname = 'artifact_bindings_file_project_fkey'
  ) THEN
    ALTER TABLE artifact_bindings
      ADD CONSTRAINT artifact_bindings_file_project_fkey
      FOREIGN KEY (file_id, project_id)
      REFERENCES files(id, project_id)
      ON DELETE CASCADE;
  END IF;
END
$$;
