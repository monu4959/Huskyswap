// POST /api/ask/feedback  { runId, value: 1 | -1 }  ->  thumbs up/down on your own question

import { askerFrom } from "@/lib/agent/auth";
import { cacheForgetRun } from "@/lib/agent/cache";
import { setFeedback } from "@/lib/agent/log";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function POST(request: Request) {
  const asker = await askerFrom(request);
  if (asker instanceof Response) return asker;

  const body = (await request.json().catch(() => null)) as { runId?: unknown; value?: unknown } | null;
  const runId = typeof body?.runId === "string" && UUID.test(body.runId) ? body.runId : null;
  const value = body?.value === 1 || body?.value === -1 ? body.value : null;
  if (!runId || !value) return Response.json({ error: "Bad request." }, { status: 400 });

  const saved = await setFeedback(runId, asker.userId, value);
  if (!saved) return Response.json({ error: "Not found." }, { status: 404 });
  // A bad answer must not be served again from the cache
  if (value === -1) await cacheForgetRun(runId);
  return Response.json({ ok: true });
}
