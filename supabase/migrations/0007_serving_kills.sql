-- =====================================================================
-- 0007: ops.serving_kills, the instant off switch for a canary model.
--
-- ml/registry.json decides which model serves (production, and a candidate
-- for a share of students); changing it takes a commit and a deploy. When a
-- canary goes wrong, `npm run canary:check -- --apply` adds the candidate
-- here and the app stops routing to it within 30 seconds; the registry
-- rollback that follows is the durable record.
-- =====================================================================

create table if not exists ops.serving_kills (
  model_id   text primary key,      -- a model id from ml/registry.json
  killed_at  timestamptz not null default now(),
  reason     text not null
);

revoke all on ops.serving_kills from public;
