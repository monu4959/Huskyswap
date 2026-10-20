-- =====================================================================
-- 0004: the text-to-SQL agent's database login and run log.
--
--   * nlq_agent: the only login the agent uses. NOINHERIT, so it can read
--     nothing until it switches to nlq_student or nlq_admin (set local role),
--     and those are the only roles it can switch to. The admin connection
--     (postgres) never runs model-written SQL.
--   * ops.agent_runs: one row per question: the full conversation, the
--     final SQL, timings and token counts. Source of training traces,
--     latency numbers and monitoring. Not exposed through the Supabase API.
--
-- The password is set outside this file:
--   alter role nlq_agent password '...';
-- and the connection string goes in .env.local as NLQ_DATABASE_URL, with
-- user nlq_agent.<project-ref> on the session pooler.
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nlq_agent') then
    create role nlq_agent login noinherit connection limit 20;
  end if;
end $$;

grant nlq_student, nlq_admin to nlq_agent with inherit false, set true;

alter role nlq_agent set default_transaction_read_only = on;
alter role nlq_agent set statement_timeout = '5s';
alter role nlq_agent set idle_in_transaction_session_timeout = '15s';
alter role nlq_agent set search_path = nlq;

-- ---------------------------------------------------------------------
-- Run log
-- ---------------------------------------------------------------------
create schema if not exists ops;
revoke all on schema ops from public;

create table if not exists ops.agent_runs (
  run_id             uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  source             text not null check (source in ('cli', 'app', 'datagen', 'eval', 'test')),
  user_id            uuid,                       -- app only: who asked
  db_role            text not null check (db_role in ('nlq_student', 'nlq_admin')),
  model              text not null,
  model_version      text,                       -- adapter tag for fine-tuned students
  prompt_version     text not null,
  schema_hash        text not null,
  question           text not null,
  messages           jsonb not null,             -- system, user, assistant (tool calls), tool results
  reasoning          jsonb,                      -- teacher's hidden reasoning per step; never trained on
  status             text not null check (status in ('answered', 'refused', 'gave_up', 'error')),
  final_sql          text,
  answer             text,
  result_rows        int,
  steps              int not null,
  sql_errors         int not null,
  prompt_tokens      int,
  completion_tokens  int,
  latency_ms         int not null,
  step_latency_ms    int[],
  error              text,
  feedback           smallint check (feedback in (-1, 1))
);
create index if not exists agent_runs_created_idx on ops.agent_runs (created_at);
create index if not exists agent_runs_user_idx on ops.agent_runs (user_id, created_at) where user_id is not null;

-- ---------------------------------------------------------------------
-- Schema card fix: join on the Boston-local *_on dates, not ::date of a UTC timestamp
-- ---------------------------------------------------------------------
comment on table nlq.calendar is 'One row per day (2019-2030) with Northeastern''s academic calendar and holidays. Join on the Boston-local *_on date columns, e.g. calendar.day = listings_all.listed_on.';
-- Periods cross semester boundaries (move-out comes after Spring ends); say so, with the dates
comment on column nlq.calendar.semester is 'Fall (Sep 3-Dec 18), Spring (Jan 7-Apr 25), Summer 1 (May 6-Jun 25), Summer 2 (Jun 30-Aug 15), or Break for days between terms. Move-in and move-out mostly fall outside semesters: find them with period and academic_year, not semester.';
comment on column nlq.calendar.period is 'move-in (Aug 25-Sep 7), classes, finals (Dec 10-18 and Apr 17-25), move-out (Apr 26-May 10), winter break (Dec 19-Jan 6) or summer break (Jun 26-29, Aug 16-24). "Spring 2025 move-out" = period ''move-out'' in academic_year ''2024-25''.';
