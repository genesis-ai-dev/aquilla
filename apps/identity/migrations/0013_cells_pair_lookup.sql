-- AD-13 branching-search corpus loader pairs source↔target by
-- (project_id, cell_id, side). The cells PK is
-- (project_id, file_id, cell_id, side) and every secondary index leads
-- with (project_id, file_id, side, ...) — file_id always sits in the
-- second slot. The corpus JOIN doesn't know file_id, so SQLite can't
-- use any existing index and the join degenerates to ~O(N) per source
-- row. On a 7k-cell project that's ~10^8 row touches in one query,
-- which blows D1's per-query CPU limit ("D1 DB exceeded its CPU time
-- limit and was reset").
CREATE INDEX idx_cells_pair_lookup ON cells(project_id, cell_id, side);
