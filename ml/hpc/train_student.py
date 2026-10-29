"""Two-stage LoRA fine-tuning of the student (Qwen3-4B) on the teacher's data.

The cluster version of ml/colab/train_student.ipynb, with the same settings, so runs
are comparable:

  stage 1  stage1.jsonl, question -> SQL (the SQL node's first turn, ending in submit_sql)
  stage 2  stage2.jsonl, every model call of the teacher's kept runs, mixed with 15% of
           stage 1 so it isn't forgotten; training continues from the stage-1 weights

Loss is only on the model's own (assistant) turns. 5% of original questions are held
out (with their variants) to report a held-out loss.

  python train_student.py --data ml/datasets --out /projects/huskyswap/adapters --run r3
"""

import argparse
import json
import random
import time

parser = argparse.ArgumentParser()
parser.add_argument("--data", required=True, help="folder with stage1.jsonl and stage2.jsonl")
parser.add_argument("--out", required=True, help="adapters go to OUT/stage1-RUN and OUT/stage2-RUN")
parser.add_argument("--run", required=True, help="name of this training run, e.g. r3")
parser.add_argument("--base", default="unsloth/Qwen3-4B-Instruct-2507")  # same weights as Qwen/Qwen3-4B-Instruct-2507
parser.add_argument("--max-len", type=int, default=8192)
parser.add_argument("--rank", type=int, default=32)
parser.add_argument("--clarify-repeat", type=int, default=1)
parser.add_argument("--seed", type=int, default=7)
args = parser.parse_args()

STAGE1 = dict(epochs=2, lr=2e-4)
STAGE2 = dict(epochs=2, lr=1e-4, stage1_mix=0.15)

from unsloth import FastLanguageModel  # noqa: E402 (Unsloth must load before transformers)
from unsloth.chat_templates import train_on_responses_only  # noqa: E402
import torch  # noqa: E402
from datasets import Dataset  # noqa: E402
from trl import SFTConfig, SFTTrainer  # noqa: E402

print(torch.cuda.get_device_name(0), f"{torch.cuda.get_device_properties(0).total_memory / 2**30:.0f} GiB")
model, tokenizer = FastLanguageModel.from_pretrained(args.base, max_seq_length=args.max_len, dtype=torch.bfloat16, load_in_4bit=False)
model = FastLanguageModel.get_peft_model(
    model, r=args.rank, lora_alpha=2 * args.rank, lora_dropout=0, bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth", random_state=args.seed)
model.print_trainable_parameters()


def load_jsonl(name):
    with open(f"{args.data}/{name}") as f:
        return [json.loads(line) for line in f if line.strip()]


def render(example):
    messages = [dict(m, content=m.get("content") or "") for m in example["messages"]]
    return tokenizer.apply_chat_template(messages, tools=example.get("tools"), tokenize=False)


def build(rows, label):
    texts = [render(r) for r in rows]
    lengths = [len(tokenizer(t).input_ids) for t in texts]
    kept = [t for t, n in zip(texts, lengths) if n <= args.max_len]
    median = sorted(lengths)[len(lengths) // 2] if lengths else 0
    print(f"{label}: {len(kept)} examples (dropped {len(texts) - len(kept)} longer than {args.max_len} tokens), median {median} tokens")
    return kept


random.seed(args.seed)
stage1_rows, stage2_rows = load_jsonl("stage1.jsonl"), load_jsonl("stage2.jsonl")
originals = sorted({r["meta"]["qid"].split("~")[0] for r in stage1_rows + stage2_rows})
held_out = set(random.sample(originals, max(1, len(originals) // 20)))
is_held = lambda r: r["meta"]["qid"].split("~")[0] in held_out  # noqa: E731

s1_train = build([r for r in stage1_rows if not is_held(r)], "stage 1 train")
s1_val = build([r for r in stage1_rows if is_held(r)], "stage 1 held-out")
s2_train = build([r for r in stage2_rows if not is_held(r)], "stage 2 train")
s2_val = build([r for r in stage2_rows if is_held(r)], "stage 2 held-out")


def train(train_texts, val_texts, epochs, lr, out):
    trainer = SFTTrainer(
        model=model, tokenizer=tokenizer,
        train_dataset=Dataset.from_dict({"text": train_texts}),
        eval_dataset=Dataset.from_dict({"text": val_texts}) if val_texts else None,
        args=SFTConfig(
            dataset_text_field="text", max_seq_length=args.max_len, packing=False,
            per_device_train_batch_size=2, gradient_accumulation_steps=8,
            num_train_epochs=epochs, learning_rate=lr, lr_scheduler_type="cosine", warmup_steps=10,
            bf16=True, logging_steps=10, eval_strategy="epoch" if val_texts else "no",
            save_strategy="no", output_dir=f"{args.out}/tmp-{out}", report_to="none", seed=args.seed))
    # Qwen renders tool results as user turns, so masking user turns also masks tool output
    trainer = train_on_responses_only(trainer, instruction_part="<|im_start|>user\n", response_part="<|im_start|>assistant\n")
    t0 = time.time()
    trainer.train()
    if val_texts:
        print(f"{out} held-out loss: {trainer.evaluate()['eval_loss']:.4f}")
    model.save_pretrained(f"{args.out}/{out}")
    tokenizer.save_pretrained(f"{args.out}/{out}")
    print(f"saved {args.out}/{out} after {(time.time() - t0) / 60:.1f} min")


train(s1_train, s1_val, STAGE1["epochs"], STAGE1["lr"], f"stage1-{args.run}")

clarify_extra = build([r for r in stage2_rows if not is_held(r) and r["meta"]["expect"] == "clarify"], "clarify examples") * (args.clarify_repeat - 1)
mix = random.sample(s1_train, int(len(s1_train) * STAGE2["stage1_mix"]))
stage2_texts = s2_train + clarify_extra + mix
random.shuffle(stage2_texts)
print(f"stage 2 training set: {len(stage2_texts)} examples")
train(stage2_texts, s2_val, STAGE2["epochs"], STAGE2["lr"], f"stage2-{args.run}")
