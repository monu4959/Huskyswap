#!/bin/bash
# Evaluate students on one H200: the base model and the chosen adapters are served side by
# side by vLLM on this node, then the usual eval runs against them. Reports land in
# code/eval/reports/ (copy them back to your laptop to commit).
#
#   sbatch ml/hpc/eval.sbatch                                         test set x3 for r2 and r3
#   ADAPTERS="base stage2-r2" REPEATS=1 sbatch ml/hpc/eval.sbatch
#   MODE=dev sbatch ml/hpc/eval.sbatch                                dev set x3
#   MODE=gate ADAPTERS=stage2-r3 sbatch ml/hpc/eval.sbatch            eval gate (registry entry needed)
#   BASE=Qwen/Qwen3-8B ADAPTERS="base stage2-r3-8b" sbatch ml/hpc/eval.sbatch   8B adapters need their base
#
#SBATCH --job-name=hs-eval
#SBATCH --partition=gpu
#SBATCH --gres=gpu:h200:1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=08:00:00
#SBATCH --output=/projects/huskyswap/logs/%x-%j.out

set -euo pipefail
source /projects/huskyswap/code/ml/hpc/env.sh
trap stop_vllm EXIT
MODE=${MODE:-test}
ADAPTERS=${ADAPTERS:-"stage2-r2 stage2-r3"}
REPEATS=${REPEATS:-3}
PARALLEL=${PARALLEL:-8}
BASE=${BASE:-Qwen/Qwen3-4B-Instruct-2507}
# Hybrid Qwen3 models (8B) wrap replies in <think></think>: the reasoning parser takes it out
case $BASE in *Qwen3-4B-Instruct-2507) thinking=() ;; *) thinking=(--reasoning-parser qwen3) ;; esac
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
db_tunnel   # before the models load, so a missing database fails in seconds

lora=()
for a in $ADAPTERS; do
  [ "$a" = base ] && continue
  [ -f "$HS/adapters/$a/adapter_config.json" ] || { echo "no adapter at $HS/adapters/$a"; exit 1; }
  lora+=("huskyswap-student-$a=$HS/adapters/$a")
done

# Same server settings as ml/colab/serve_trained_student.ipynb
start_vllm student 8001 "$BASE" \
  --max-model-len 32768 --gpu-memory-utilization 0.85 \
  --enable-auto-tool-choice --tool-call-parser hermes ${thinking[@]+"${thinking[@]}"} \
  ${lora[@]:+--enable-lora --max-lora-rank 64 --max-loras ${#lora[@]} --lora-modules "${lora[@]}"}

export STUDENT_BASE_URL=http://127.0.0.1:8001/v1 STUDENT_API_KEY=$VLLM_KEY
cd "$HS_CODE"
for a in $ADAPTERS; do
  if [ "$a" = base ]; then
    model=$BASE
    case $BASE in *Qwen3-4B-Instruct-2507) label=qwen3-4b-base ;; *) label=$(basename "$BASE" | tr '[:upper:]' '[:lower:]')-base ;; esac
  else
    model=huskyswap-student-$a
    label=$a
  fi
  smoke_test "$model" 8001
  export STUDENT_MODEL=$model STUDENT_VERSION=$label
  case $MODE in
    test) for k in $(seq 1 "$REPEATS"); do npm run -s eval -- --set=eval/test-set.json --model=student --parallel="$PARALLEL" --label="test-student-$label-run$k"; done ;;
    dev) for k in $(seq 1 "$REPEATS"); do npm run -s eval -- --model=student --parallel="$PARALLEL" --label="student-$label-hpc-run$k"; done ;;
    gate) npm run -s gate -- --candidate="$a" ;;
    *) echo "unknown MODE $MODE (test, dev or gate)"; exit 1 ;;
  esac
done
grep -l '"errors": [1-9]' eval/reports/*.json 2> /dev/null | sed 's/^/has errored items (rerun with npm run eval -- --update=...): /' || true
