-- =====================================================================
-- 0011: assistant hardening (rogue-model red team, scripts/redteam-assistant.mjs,
-- and security review finding M1). Apply after 0009 and 0010. Safe to re-run.
--
--   * Leaky view: nlq.listings filters listings_all down to what is available
--     right now, but it was not a security barrier, so the planner pushed a
--     user's cheap predicate below that filter and evaluated it on sold, rented
--     and removed listings too. A predicate that errors quotes the row:
--       select count(*) from nlq.listings where title like 'X%' and title::boolean
--       -> invalid input syntax for type boolean: "<title of a SOLD listing>"
--     (and description, prices, deposits the same way), and a model can relay
--     that message. security_barrier keeps every non-leakproof user predicate
--     above the view's own filter. The other student-visible views
--     (meetup_spots, categories) have no filter today; they get it too so a
--     future filter can't reintroduce the leak. (The my_* views already have
--     it, 0005.) If a later migration recreates one of these views, it must say
--     "with (security_barrier)" again: CREATE OR REPLACE VIEW resets options.
--
--   * M1: nlq_agent is granted both nlq_student and nlq_admin, so only the SQL
--     guard stops a student's query from becoming nlq_admin with
--     set_config('role', 'nlq_admin', true). nlq_agent_student is a second
--     login that can only become nlq_student; the app uses it for student
--     questions when NLQ_STUDENT_DATABASE_URL is set (src/lib/agent/db.ts) and
--     falls back to nlq_agent otherwise. Same settings as nlq_agent (0004). Its
--     password is set outside this file:
--       alter role nlq_agent_student password '...';
--     and the app connects as nlq_agent_student.<project-ref> on the
--     transaction pooler (port 6543).
--
--   * Semantic cache: ops.query_cache.asked_by records whose run stored an
--     entry. A cached answer's TEXT is only reused for that same student;
--     anyone else hitting the entry gets the SQL re-run as themselves and a
--     fresh answer, so model-written text never crosses users
--     (src/lib/agent/graph.ts serve, src/lib/agent/cache.ts). Existing entries
--     were stored under the old, weaker scoping, so they are dropped.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Student-visible views are security barriers
-- ---------------------------------------------------------------------
alter view nlq.listings set (security_barrier = true);
alter view nlq.meetup_spots set (security_barrier = true);
alter view nlq.categories set (security_barrier = true);

-- ---------------------------------------------------------------------
-- M1: a student-only database login
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nlq_agent_student') then
    create role nlq_agent_student login noinherit connection limit 20;
  end if;
end $$;

-- Can switch to nlq_student (set local role) and nothing else; reads nothing without switching
grant nlq_student to nlq_agent_student with inherit false, set true;
do $$
begin
  if exists (
    select 1 from pg_auth_members m
    where m.member = 'nlq_agent_student'::regrole and m.roleid <> 'nlq_student'::regrole
  ) then
    raise exception 'nlq_agent_student must be a member of nlq_student only';
  end if;
end $$;

alter role nlq_agent_student set default_transaction_read_only = on;
alter role nlq_agent_student set statement_timeout = '5s';
alter role nlq_agent_student set idle_in_transaction_session_timeout = '15s';
alter role nlq_agent_student set search_path = nlq;

-- ---------------------------------------------------------------------
-- Semantic cache: who stored each entry
-- ---------------------------------------------------------------------
alter table ops.query_cache add column if not exists asked_by uuid;
comment on column ops.query_cache.asked_by is 'Student whose run stored the entry (null from the CLI). Its answer text is reused only for this student.';

-- Entries stored under the old rules may be shared although their SQL reads a my_* view
-- spelled so the old regex missed it, or selects model-chosen text. It's a cache: start
-- over (on a re-run this also drops entries stored from the CLI, which is harmless).
delete from ops.query_cache where asked_by is null;
