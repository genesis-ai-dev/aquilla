-- Style-rule library + applicability graph (AQU-934; structured rule
-- extraction phase 2). Rules follow the agent_memories propose→approve
-- lifecycle and the knowledge_docs org XOR project scoping. Applicability
-- rows override scope inheritance at narrower targets; inherited coverage is
-- COMPUTED at read time — assigned_by='inherited' rows exist only when
-- inheritance is deliberately materialized (audit/perf).
CREATE TABLE IF NOT EXISTS style_rules (
  id text PRIMARY KEY,                    -- uuidv7
  org_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT,
  instruction text NOT NULL,              -- normalized imperative rule text (prompt-injectable)
  category text NOT NULL DEFAULT 'style'
    CHECK (category IN ('terminology','register','formatting','grammar','orthography','style','other')),
  scope text NOT NULL DEFAULT 'global'    -- broadest intended reach
    CHECK (scope IN ('global','genre','document','section','passage','segment')),
  conditions text,                        -- free-text conditions ("only in direct speech")
  examples jsonb,                         -- [{before?, after?, note?}]
  exceptions text,
  source jsonb,                           -- citation: {kind:'knowledge-doc',docId,nodeId?,quote?}|{kind:'manual'}|{kind:'edits'}
  check_spec jsonb,                       -- optional deterministic RuleCheck (regex enforcement)
  severity text NOT NULL DEFAULT 'minor' CHECK (severity IN ('major','minor')),
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','archived')),
  human_edited boolean NOT NULL DEFAULT false,
  provenance jsonb,                       -- {extractionId?, docSha?, …}
  created_by text,
  reviewed_by text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((org_id IS NULL) <> (project_id IS NULL))
);
CREATE INDEX IF NOT EXISTS style_rules_project ON style_rules (project_id, status) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS style_rules_org ON style_rules (org_id, status) WHERE org_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS rule_applicability (
  id text PRIMARY KEY,                    -- uuidv7
  rule_id text NOT NULL REFERENCES style_rules(id) ON DELETE CASCADE,
  target_type text NOT NULL
    CHECK (target_type IN ('genre','file','book','section','passage','segment')),
  target_id text NOT NULL,                -- genre name | fileId | 'PSA' | 'PSA 23' | 'LUK 1:1-4' | cellId
  relationship text NOT NULL CHECK (relationship IN ('applies','likely_applies','excluded')),
  confidence real,                        -- model-assigned only
  reason text,
  assigned_by text NOT NULL CHECK (assigned_by IN ('human','model','inherited')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS rule_applicability_rule ON rule_applicability (rule_id);
