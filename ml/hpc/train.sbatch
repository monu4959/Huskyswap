#!/bin/bash
# Train a student run on one H200 (both stages; about an hour for r2-sized data).
# Reads ml/datasets/stage{1,2}.jsonl, writes /projects/huskyswap/adapters/stage{1,2}-RUN.
#
#   RUN=r3 sbatch ml/hpc/train.sbatch
#
#SBATCH --job-name=hs-train
#SBATCH --partition=gpu
#SBATCH --gres=gpu:h200:1
#SBATCH --cpus-per-task=16
#SBATCH --mem=128G
#SBATCH --time=04:00:00
#SBATCH --output=/projects/huskyswap/logs/%x-%j.out

set -euo pipefail
source /projects/huskyswap/code/ml/hpc/env.sh
RUN=${RUN:?set RUN, e.g. RUN=r3}
if [ -e "$HS/adapters/stage2-$RUN" ]; then echo "$HS/adapters/stage2-$RUN already exists: pick a new RUN name"; exit 1; fi
sha256sum "$HS_CODE/ml/datasets/stage1.jsonl" "$HS_CODE/ml/datasets/stage2.jsonl"   # for the registry
"$HS/env/train/bin/python" "$HS_CODE/ml/hpc/train_student.py" --data "$HS_CODE/ml/datasets" --out "$HS/adapters" --run "$RUN"
rm -rf "$HS/adapters/tmp-stage1-$RUN" "$HS/adapters/tmp-stage2-$RUN"
