// Shared types for the text-to-SQL agent.

export type DbRole = "nlq_student" | "nlq_admin";

export type ColumnCard = { name: string; type: string; description?: string };
export type ViewCard = { name: string; description: string; roles: DbRole[]; columns: ColumnCard[] };

// OpenAI-compatible chat messages (what the teacher API and vLLM both speak)
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type SqlResult =
  | { ok: true; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean }
  | { ok: false; error: string };

export type RunStatus = "answered" | "refused" | "clarify" | "gave_up" | "error";

// The graph's nodes, in order
export type NodeName = "cache" | "retrieve" | "clarify" | "sql" | "answer";
export type NodeRecord = { node: NodeName; ms: number; outcome: string };

// One model call, kept whole: these become training examples for the student
export type ModelCall = {
  node: NodeName;
  messages: ChatMessage[];
  reply: { content: string | null; tool_calls?: ToolCall[] };
  reasoning: string | null; // the teacher's hidden reasoning; never trained on
  promptTokens: number;
  completionTokens: number;
  ms: number;
};

export type Clarification = { question: string; options: string[] };
export type ClarificationTurn = { question: string; answer: string };

export type RetrievalSummary = {
  views: string[];
  values: string[];
  titles: string[];
  glossary: string[];
  examples: { question: string; score: number }[];
  ms: number;
};

export type AgentRun = {
  runId: string | null; // null when logging is off
  question: string;
  resolvedQuestion: string | null; // after any clarification; what the cache stores
  role: DbRole;
  status: RunStatus;
  answer: string | null;
  finalSql: string | null;
  result: SqlResult | null; // the final SQL's result, for the UI
  clarification: Clarification | null; // set when status is "clarify"
  cacheHit: boolean;
  grounded: boolean | null; // every number in the answer appears in the result
  retrieval: RetrievalSummary | null;
  nodes: NodeRecord[];
  calls: ModelCall[];
  messages: ChatMessage[]; // the SQL node's conversation: the multi-step training trace
  sqlErrors: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  error: string | null;
};
