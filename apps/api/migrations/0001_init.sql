-- LocalMax live result store.
--
-- D1 is the read/write store the website serves from. It is a rebuildable index: the
-- canonical archive is the accepted manifests committed to `results/` in Git. Anything
-- here can be reconstructed with `scripts/rebuild-index.mjs`.

-- ---------------------------------------------------------------------------
-- submissions: short-lived state for an in-flight submission.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS submissions (
  run_id            TEXT PRIMARY KEY,
  nonce             TEXT NOT NULL,
  state             TEXT NOT NULL,          -- awaiting_upload|queued|validating|accepted|rejected|flagged
  profile_id        TEXT NOT NULL,
  manifest_json     TEXT NOT NULL,
  declared_bytes    INTEGER NOT NULL,
  uploaded_bytes    INTEGER NOT NULL DEFAULT 0,
  pending_artifacts INTEGER NOT NULL DEFAULT 0,
  submitter_ip_hash TEXT,                   -- salted hash, for abuse detection only, TTL'd by cleanup
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  findings_json     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_nonce ON submissions(nonce);
CREATE INDEX IF NOT EXISTS idx_submissions_state ON submissions(state, updated_at);

-- ---------------------------------------------------------------------------
-- artifacts: content-addressed evidence. One row per distinct hash, refcounted so
-- two results referencing the same file store it once and neither can orphan it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifacts (
  hash        TEXT PRIMARY KEY,
  size_bytes  INTEGER NOT NULL,
  media_type  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  refcount    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_orphan ON artifacts(refcount, created_at);

CREATE TABLE IF NOT EXISTS result_artifacts (
  run_id  TEXT NOT NULL,
  hash    TEXT NOT NULL,
  name    TEXT NOT NULL,
  kind    TEXT NOT NULL,
  PRIMARY KEY (run_id, hash)
);

CREATE INDEX IF NOT EXISTS idx_result_artifacts_hash ON result_artifacts(hash);

-- ---------------------------------------------------------------------------
-- results: the denormalized row every leaderboard, filter and chart reads.
-- Columns are wide on purpose. A leaderboard query must never touch manifest_json.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS results (
  run_id                 TEXT PRIMARY KEY,
  created_at             TEXT NOT NULL,          -- when the benchmark ran
  accepted_at            TEXT NOT NULL,          -- when validation accepted it
  verification           TEXT NOT NULL,          -- community|verified|flagged
  ranked                 INTEGER NOT NULL DEFAULT 0,

  profile_id             TEXT NOT NULL,
  profile_version        TEXT NOT NULL,
  category               TEXT NOT NULL,
  tier                   TEXT NOT NULL,
  lane                   TEXT NOT NULL,

  gpu_key                TEXT NOT NULL,
  gpu_name               TEXT NOT NULL,
  gpu_count              INTEGER NOT NULL,
  gpu_architecture       TEXT,
  vram_bytes             INTEGER,
  parallelism            TEXT NOT NULL DEFAULT 'none',
  interconnect           TEXT,
  memory_type            TEXT,

  cpu_model              TEXT,
  cpu_arch               TEXT,
  system_ram_bytes       INTEGER,
  os                     TEXT,
  driver                 TEXT,
  cuda                   TEXT,
  virtualization         TEXT,

  runtime                TEXT,
  runtime_version        TEXT,
  model_repository       TEXT,
  model_revision         TEXT,
  model_precision        TEXT,
  container_digest       TEXT,
  container_official     INTEGER NOT NULL DEFAULT 0,
  runner_version         TEXT,

  headline_metric        TEXT NOT NULL,
  headline_value         REAL NOT NULL,
  headline_unit          TEXT NOT NULL,
  headline_direction     TEXT NOT NULL DEFAULT 'higher_is_better',

  -- Cross-category comparable columns. NULL where the category does not produce them.
  decode_tok_s           REAL,
  prefill_tok_s          REAL,
  peak_tok_s             REAL,
  ttft_p50_ms            REAL,
  ttft_p95_ms            REAL,
  itl_p95_ms             REAL,
  e2e_p50_ms             REAL,
  seconds_per_step_s     REAL,
  images_per_minute      REAL,
  quality_gate_pct       REAL,
  longcontext_pass       INTEGER,
  model_load_s           REAL,

  vram_peak_bytes        INTEGER,
  power_avg_w            REAL,
  power_peak_w           REAL,
  power_domain           TEXT NOT NULL DEFAULT 'unavailable',
  energy_per_unit_j      REAL,
  efficiency             REAL,                   -- headline value per watt, NULL when power_domain is unavailable
  telemetry_coverage_pct REAL,
  throttle_thermal       INTEGER DEFAULT 0,
  throttle_power         INTEGER DEFAULT 0,
  temperature_peak_c     REAL,

  alias                  TEXT,
  system_name            TEXT,
  system_key             TEXT,
  cooling                TEXT,
  tuning                 TEXT,
  notes                  TEXT,

  manifest_json          TEXT NOT NULL,
  findings_json          TEXT,
  archived_at            TEXT                    -- set once committed to results/ in Git
);

-- The leaderboard query: filter by profile, ranked only, order by headline.
CREATE INDEX IF NOT EXISTS idx_results_leaderboard
  ON results(profile_id, ranked, headline_value DESC);
CREATE INDEX IF NOT EXISTS idx_results_leaderboard_asc
  ON results(profile_id, ranked, headline_value ASC);
-- The hardware page and the percentile-within-GPU calculation.
CREATE INDEX IF NOT EXISTS idx_results_gpu
  ON results(gpu_key, profile_id, ranked, headline_value);
-- Recent results on the landing page and the /results firehose.
CREATE INDEX IF NOT EXISTS idx_results_recent
  ON results(accepted_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_category
  ON results(category, tier, lane, accepted_at DESC);
-- A contributor's own system history.
CREATE INDEX IF NOT EXISTS idx_results_system
  ON results(system_key, accepted_at DESC);
-- The hourly archive job.
CREATE INDEX IF NOT EXISTS idx_results_unarchived
  ON results(archived_at, accepted_at);
-- Duplicate detection: the same machine resubmitting an identical run.
CREATE INDEX IF NOT EXISTS idx_results_dupe
  ON results(system_key, profile_id, headline_value);

-- ---------------------------------------------------------------------------
-- profile_stats: refreshed after each accepted result so leaderboard pages can
-- render distribution context without a full scan.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profile_stats (
  profile_id     TEXT NOT NULL,
  gpu_key        TEXT NOT NULL,        -- '*' for the whole profile
  gpu_count      INTEGER NOT NULL DEFAULT 1,
  sample_count   INTEGER NOT NULL,
  best_value     REAL,
  p25_value      REAL,
  mean_value     REAL,
  p75_value      REAL,
  worst_value    REAL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (profile_id, gpu_key, gpu_count)
);

-- ---------------------------------------------------------------------------
-- audit: every change to a verification state, append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,          -- 'validator' | 'cron' | 'maintainer:<handle>'
  action      TEXT NOT NULL,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_run ON audit(run_id, at);
