#!/bin/bash
# Training data on one H200: the teacher (gpt-oss-120b) is served by vLLM on this node
# and `npm run datagen` runs next to it, so nothing leaves the node but database queries.
# Every stage resumes where it stopped, so when the job runs out of time, submit it again.
#
#   sbatch ml/hpc/datagen.sbatch                                  explore 60 rounds, then the checks
#   ROUNDS=120 sbatch ml/hpc/datagen.sbatch
#   STAGES="traces export" sbatch ml/hpc/datagen.sbatch           just finish the later stages
#   ROUNDS=2 STAGES="explore" sbatch -t 01:00:00 -p gpu-short ml/hpc/datagen.sbatch   a quick test
#
#SBATCH --job-name=hs-datagen
#SBATCH --partition=gpu
#SBATCH --gres=gpu:h200:1
#SBATCH --cpus-per-task=16
#SBATCH --mem=128G
#SBATCH --time=08:00:00
#SBATCH --output=/projects/huskyswap/logs/%x-%j.out

set -euo pipefail
source /projects/huskyswap/code/ml/hpc/env.sh
trap stop_vllm EXIT
JOB_START=$(date +%s)
JOB_MINUTES=${JOB_MINUTES:-$(squeue -h -j "$SLURM_JOB_ID" -o %l | awk -F'[-:]' '{ if (NF == 4) print $1*1440 + $2*60 + $3; else if (NF == 3) print $1*60 + $2; else print $1 }')}
STAGES=${STAGES:-"explore reword reference traces export"}
ROUNDS=${ROUNDS:-60}
PARALLEL=${PARALLEL:-12}
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

# Same server settings as the Colab teacher (ml/colab/serve_teacher.ipynb)
start_vllm teacher 8000 openai/gpt-oss-120b \
  --max-model-len 32768 --gpu-memory-utilization 0.92 \
  --enable-auto-tool-choice --tool-call-parser openai

# These override .env.local: the teacher is this node's server, and the Groq key pool is off
export TEACHER_BASE_URL=http://127.0.0.1:8000/v1 TEACHER_API_KEY=$VLLM_KEY TEACHER_API_KEYS= TEACHER_MODEL=openai/gpt-oss-120b

cd "$HS_CODE"
for stage in $STAGES; do
  left=$(minutes_left)
  if [ "$stage" != export ] && [ "$left" -le 5 ]; then
    echo "out of time before $stage: submit the job again to continue"
    break
  fi
  echo "== $stage ($left min left)"
  case $stage in
    explore) npm run -s datagen -- --stage=explore --rounds="$ROUNDS" --parallel="$PARALLEL" --max-minutes="$left" ;;
    export) npm run -s datagen -- --stage=export ;;
    *) npm run -s datagen -- --stage="$stage" --parallel="$PARALLEL" --max-minutes="$left" ;;
  esac
done
