-- Clustered systems.
--
-- A Prospector system can be several machines. The tier comes from the total VRAM across
-- all of them, so eight DGX Sparks are one system, not eight. The node count is recorded
-- because a run across a network fabric does not compare with one inside a single box.

ALTER TABLE results ADD COLUMN node_count INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_results_nodes ON results(profile_id, node_count, ranked);
