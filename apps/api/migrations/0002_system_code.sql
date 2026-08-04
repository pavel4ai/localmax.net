-- Public system labels.
--
-- Every result is shown under a name derived from its public key rather than anything a
-- person typed. The five-character code is what a contributor uses to find their own
-- results later, so it needs its own index: it is a primary access path, not a filter.

ALTER TABLE results ADD COLUMN system_code TEXT;

CREATE INDEX IF NOT EXISTS idx_results_code ON results(system_code, accepted_at DESC);
