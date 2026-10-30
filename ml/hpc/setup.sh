#!/bin/bash
# One-time setup in /projects/huskyswap: Node.js, uv, the two Python environments,
# the npm packages and the model weights. Safe to rerun; finished steps are skipped.
#
# Clone the repo first (login node), then submit this as a CPU job:
#   git clone -b text-to-sql-agent https://github.com/monu4959/Huskyswap.git /projects/huskyswap/code
#   sbatch /projects/huskyswap/code/ml/hpc/setup.sh
#
#SBATCH --job-name=hs-setup
#SBATCH --partition=short
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --time=06:00:00
#SBATCH --output=/projects/huskyswap/logs/%x-%j.out

set -euo pipefail
source /projects/huskyswap/code/ml/hpc/env.sh
mkdir -p "$HS/bin" "$HS/env" "$HS/cache"

# Node.js 24 (the version the app and CI use), checksum-verified
if [ ! -x "$HS/node/bin/node" ]; then
  dist=https://nodejs.org/dist/latest-v24.x
  sums=$(curl -fsSL "$dist/SHASUMS256.txt")
  tarball=$(echo "$sums" | awk '/linux-x64\.tar\.xz$/ {print $2}')
  curl -fsSL -o "$HS/cache/$tarball" "$dist/$tarball"
  (cd "$HS/cache" && echo "$sums" | grep " $tarball\$" | sha256sum -c -)
  mkdir -p "$HS/node" && tar -xJf "$HS/cache/$tarball" -C "$HS/node" --strip-components=1
fi
echo "node $(node --version)"

# uv: Python and package manager, no admin rights needed
if [ ! -x "$HS/bin/uv" ]; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$HS/bin" UV_NO_MODIFY_PATH=1 sh
fi
echo "$(uv --version)"

# Two environments, because vLLM and Unsloth pin different library versions.
# The GPU nodes' driver (570) supports CUDA 12.8, but the default PyTorch and vLLM builds now
# target CUDA 13 and fail with "driver too old". CUDA 12.9 builds run on 12.8 drivers (NVIDIA's
# minor-version compatibility), and 12.9 is the oldest CUDA current vLLM is built for.
TORCH_CUDA=cu129
VLLM_VERSION=0.32.0
cuda12() { [ -x "$1/bin/python" ] && "$1/bin/python" -c "import sys, torch; sys.exit(not (torch.version.cuda or '').startswith('12.'))" 2> /dev/null; }
if ! cuda12 "$HS/env/vllm" || [ ! -x "$HS/env/vllm/bin/vllm" ]; then
  uv venv --clear --python 3.12 "$HS/env/vllm"
  VIRTUAL_ENV="$HS/env/vllm" uv pip install --torch-backend="$TORCH_CUDA" \
    "https://github.com/vllm-project/vllm/releases/download/v$VLLM_VERSION/vllm-$VLLM_VERSION+$TORCH_CUDA-cp38-abi3-manylinux_2_28_x86_64.whl"
fi
# (find_spec, not import: importing Unsloth on a CPU node fails because there is no GPU)
if ! cuda12 "$HS/env/train" || ! "$HS/env/train/bin/python" -c "import sys, importlib.util as u; sys.exit(u.find_spec('unsloth') is None)"; then
  uv venv --clear --python 3.12 "$HS/env/train"
  # xformers has no CUDA 12.9 build for this PyTorch; Unsloth falls back to PyTorch's own attention
  echo xformers > "$HS/cache/no-xformers.txt"
  VIRTUAL_ENV="$HS/env/train" uv pip install --torch-backend="$TORCH_CUDA" --excludes "$HS/cache/no-xformers.txt" unsloth
fi
"$HS/env/vllm/bin/python" -c "import torch, vllm; print('vllm', vllm.__version__, 'torch', torch.__version__)"
"$HS/env/train/bin/python" -c "import torch; print('train torch', torch.__version__)"

# The app's packages (the agent, datagen and eval scripts run under Node)
(cd "$HS_CODE" && npm ci --no-audit --no-fund)

# Model weights, so GPU jobs don't spend their time downloading
for model in openai/gpt-oss-120b Qwen/Qwen3-4B-Instruct-2507 unsloth/Qwen3-4B-Instruct-2507 Qwen/Qwen3-8B unsloth/Qwen3-8B; do
  "$HS/env/vllm/bin/hf" download "$model" > /dev/null
  echo "downloaded $model"
done

echo
echo "setup done. Still to copy in by hand (see ml/hpc/README.md):"
[ -f "$HS_CODE/.env.local" ] || echo "  $HS_CODE/.env.local"
[ -f "$HS_CODE/ml/datasets/work/questions.jsonl" ] || echo "  $HS_CODE/ml/datasets/ (stage files and work/)"
[ -f "$HS/adapters/stage2-r2/adapter_config.json" ] || echo "  $HS/adapters/stage2-r2/ (from Google Drive)"
du -sh "$HS" 2> /dev/null || true
