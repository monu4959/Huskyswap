# Run 3 on the Explorer cluster

Data generation, training and evaluation on one H200 (141 GB) per job, instead of Colab.
Offline work only: the app is never served from the cluster and no tunnels are opened.

| Script | GPU | What it does |
|---|---|---|
| `setup.sh` | none (`short`) | Node.js, uv, the vLLM and Unsloth environments, npm packages, model weights |
| `datagen.sbatch` | 1× H200, 8 h | serves the teacher on the node and runs `npm run datagen` (explore → reword → reference → traces → export) |
| `train.sbatch` | 1× H200, ~1 h | two-stage LoRA (`train_student.py`, same settings as the Colab notebook) |
| `eval.sbatch` | 1× H200 | serves the students on the node; test set ×3, dev set ×3, or the eval gate |

Everything lives in `/projects/huskyswap` (see `env.sh`).

## 1. Once: set up (login node)

```bash
mkdir -p /projects/huskyswap/logs
git clone -b text-to-sql-agent https://github.com/monu4959/Huskyswap.git /projects/huskyswap/code
sbatch /projects/huskyswap/code/ml/hpc/setup.sh        # a CPU job, about an hour (downloads ~80 GB)
```

## 2. Once: copy what isn't in git (from your laptop, in the repo folder)

Use the host you SSH into (`<login>` below).

```bash
scp .env.local kolla.ro@<login>:/projects/huskyswap/code/
scp -r ml/datasets kolla.ro@<login>:/projects/huskyswap/code/ml/
ssh kolla.ro@<login> chmod 600 /projects/huskyswap/code/.env.local
```

The r2 adapter is in Google Drive at `MyDrive/huskyswap/adapters/stage2-r2`: download the
folder, then copy it to `/projects/huskyswap/adapters/stage2-r2/` (it must contain
`adapter_config.json`).

Rerun `setup.sh` any time; its last lines list anything still missing.

## 3. Test the explore stage (2 rounds, under an hour)

```bash
cd /projects/huskyswap/code
ROUNDS=2 STAGES=explore sbatch -p gpu-short -t 01:00:00 ml/hpc/datagen.sbatch
tail -f /projects/huskyswap/logs/hs-datagen-<jobid>.out
tail ml/datasets/work/explore.jsonl          # per round: asked, kept, and why the rest were dropped
```

## 4. Generate the data

```bash
sbatch ml/hpc/datagen.sbatch                 # 60 explore rounds, then the checks
```

When a job runs out of time it prints "submit the job again to continue": do that until the
log ends with the export stats. Then `ml/datasets/stats.json` shows the new totals.

## 5. Train run 3

```bash
RUN=r3 sbatch ml/hpc/train.sbatch            # adapters: /projects/huskyswap/adapters/stage2-r3
```

The log prints both held-out losses and the data hashes for the registry.

## 6. Evaluate

Add `stage2-r3` to `ml/registry.json` first (on your laptop, then `git pull` here), then:

```bash
MODE=gate ADAPTERS=stage2-r3 sbatch ml/hpc/eval.sbatch    # dev set vs production; writes eval/gates/
sbatch ml/hpc/eval.sbatch                                  # test set, 3 runs each for r2 and r3
```

Copy the reports and gate file back to your laptop and commit them there:

```bash
scp kolla.ro@<login>:/projects/huskyswap/code/eval/reports/*-run[123].json eval/reports/
scp kolla.ro@<login>:/projects/huskyswap/code/eval/gates/*.json eval/gates/
```

## Useful commands

```bash
squeue -u $USER                    # your jobs (PD = waiting for a GPU, R = running)
scancel <jobid>                    # stop a job
sacct -j <jobid> --format=JobID,State,Elapsed,MaxRSS
du -sh /projects/huskyswap         # space used (quota 1 TB)
```
