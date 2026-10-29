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

stop_vllm() {
  for pid in ${VLLM_PIDS:-}; do kill "$pid" 2> /dev/null || true; done
}

# Minutes left in this job, minus a margin for saving and shutting down
minutes_left() {
  local margin=${1:-15}
  echo $(( (JOB_START + JOB_MINUTES * 60 - $(date +%s)) / 60 - margin ))
}
