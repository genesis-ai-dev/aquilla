-- Knowledge base documents (spec: docs/superpowers/specs/2026-08-07-knowledge-base-design.md).
-- Org XOR project scoped context documents; originals in R2 (kb/ prefix),
-- extracted text + PageIndex-style tree here.
CREATE TABLE knowledge_docs (
    id UUID PRIMARY KEY,
    org_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT,
    name TEXT NOT NULL,
    content_type TEXT,
    size_bytes BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    extracted_text TEXT NOT NULL,
    doc_summary TEXT,
    index_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (index_status IN ('pending','ready','failed')),
    index_tree JSONB,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((org_id IS NULL) <> (project_id IS NULL))
);
CREATE INDEX knowledge_docs_project ON knowledge_docs (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX knowledge_docs_org ON knowledge_docs (org_id) WHERE org_id IS NOT NULL;
