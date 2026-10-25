-- =====================================================================
-- 0008: ops.training_questions, the questions a student model was trained
-- on, embedded (gte-small, like rag_docs). The drift monitor (npm run drift)
-- measures how close live questions are to the nearest one: questions far
-- from all of them are where the student is weakest. Loaded by
-- `npm run drift -- index` from ml/datasets (not in git).
-- =====================================================================

create table if not exists ops.training_questions (
  dataset    text not null,              -- the training data's stage-2 sha256 (ml/registry.json)
  qid        text not null,
  question   text not null,
  expect     text not null check (expect in ('answer', 'refuse', 'clarify')),
  embedding  extensions.vector(384) not null,
  primary key (dataset, qid)
);
create index if not exists training_questions_embedding_idx on ops.training_questions using hnsw (embedding extensions.vector_cosine_ops);

revoke all on ops.training_questions from public;
