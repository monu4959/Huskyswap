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

export type RunStatus = "answered" | "refused" | "gave_up" | "error";

export type AgentRun = {
  runId: string | null; // null when logging is off
  question: string;
  role: DbRole;
  status: RunStatus;
  answer: string | null;
  finalSql: string | null;
  result: SqlResult | null; // the final SQL's result, for the UI
  messages: ChatMessage[];
  reasoning: (string | null)[];
  steps: number;
  sqlErrors: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  stepLatencyMs: number[];
  error: string | null;
};
