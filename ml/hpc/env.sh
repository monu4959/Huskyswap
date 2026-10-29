# Paths, caches and helpers for HuskySwap jobs on Northeastern's Explorer cluster.
# Every job script sources this; nothing big lives in the home directory.
#
#   /projects/huskyswap/
#     code/       this repository (ml/datasets/ and .env.local copied in by hand)
#     env/        Python environments: vllm (serving), train (Unsloth)
#     node/ bin/  Node.js and uv
#     hf-cache/   model downloads (gpt-oss-120b ~65 GB, Qwen3-4B ~8 GB)
#     adapters/   trained LoRA adapters (stage2-r2 from Google Drive, stage2-r3 ...)
#     logs/       job and server logs

export HS=/projects/huskyswap
export HS_CODE=$HS/code
export HF_HOME=$HS/hf-cache
export UV_CACHE_DIR=$HS/cache/uv
export npm_config_cache=$HS/cache/npm
export EMBED_CACHE_DIR=$HS/cache/models   # gte-small, for retrieval and the novelty filter
export PATH=$HS/node/bin:$HS/bin:$PATH
mkdir -p "$HS/logs" "$HS/adapters" "$HF_HOME"

# A key for the local model servers: other users' jobs can share the node and reach 127.0.0.1
export VLLM_KEY=${VLLM_KEY:-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')}

# start_vllm NAME PORT MODEL [vllm args...]: serve on 127.0.0.1 and wait until it answers
start_vllm() {
  local name=$1 port=$2
  shift 2
  local log="$HS/logs/$name-${SLURM_JOB_ID:-local}.vllm.log"
  "$HS/env/vllm/bin/vllm" serve "$@" --host 127.0.0.1 --port "$port" --api-key "$VLLM_KEY" > "$log" 2>&1 &
  local pid=$!
  VLLM_PIDS="${VLLM_PIDS:-} $pid"
  echo "starting $name on port $port (log: $log)"
  local waited=0
  until curl -sf "http://127.0.0.1:$port/health" > /dev/null; do
    if ! kill -0 "$pid" 2> /dev/null; then echo "$name exited; last log lines:"; tail -40 "$log"; return 1; fi
    if [ "$waited" -ge 2400 ]; then echo "$name not ready after 40 min"; tail -40 "$log"; return 1; fi
    sleep 15
    waited=$((waited + 15))
  done
  echo "$name ready after ${waited}s"
}

# smoke_test MODEL PORT: one tool call, the way the agent makes them; stops the job if the
# reply has no tool call or leaks <think> tags into the content
smoke_test() {
  "$HS/env/vllm/bin/python" - "$1" "$2" << 'PY'
import json, os, sys, urllib.request
model, port = sys.argv[1], sys.argv[2]
body = {"model": model, "max_tokens": 512,
        "messages": [{"role": "user", "content": "How many listings are there? Use the tool."}],
        "tools": [{"type": "function", "function": {"name": "run_sql", "description": "Run a SQL query",
                   "parameters": {"type": "object", "properties": {"sql": {"type": "string"}}, "required": ["sql"]}}}],
        "tool_choice": "auto"}
req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", data=json.dumps(body).encode(),
                             headers={"content-type": "application/json", "authorization": "Bearer " + os.environ["VLLM_KEY"]})
msg = json.load(urllib.request.urlopen(req, timeout=300))["choices"][0]["message"]
calls, content = msg.get("tool_calls") or [], msg.get("content") or ""
print(f"smoke test {model}: {len(calls)} tool call(s) {json.dumps(calls)[:200]}")
if not calls or "<think>" in content:
    sys.exit(f"smoke test failed for {model}: content was {content[:300]!r}")
PY
}

stop_vllm() {
  for pid in ${VLLM_PIDS:-}; do kill "$pid" 2> /dev/null || true; done
}

# Minutes left in this job, minus a margin for saving and shutting down
minutes_left() {
  local margin=${1:-15}
  echo $(( (JOB_START + JOB_MINUTES * 60 - $(date +%s)) / 60 - margin ))
}
