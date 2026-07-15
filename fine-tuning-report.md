# Fine-Tuning Report

Six LoRA fine-tuning trials of `mlx-community/Qwen3-VL-8B-Instruct-4bit` (8-bit for one trial), trained to generate WCAG-compliant album-cover alt text in a structured tagged format. All trials trained locally on Apple Silicon via `scripts/train_lora_with_val.py`, a custom trainer built on top of `mlx_vlm` that adds real validation-loss tracking (the stock `mlx_vlm.lora` CLI silently ignores `--val-dataset`).

Two output formats were used across these trials:
- **4-tag format** (trials 1-4): `<description>`, `<confidence-score>`, `<confidence-reasoning>`, `<review-triggers>`
- **3-tag format** (trials 5-6): `<description>`, `<confidence-score>`, `<review-triggers>` — `confidence-reasoning` was dropped after trial 4 showed the model prioritizing that field (the longest one in the training data) at the expense of everything else.

All evaluations below were run with `scripts/04_generate_alt_text.py` against the 80-row `data/valid.jsonl` validation set, using `is_well_formed()` checked against **each trial's own native format** (the checker's regex was updated when the format changed after trial 4; trials 1-4 are scored against the original 4-tag contract, trials 5-6 against the current 3-tag contract).

---

## 1. Results: Best Adapter per Trial

"Best" = the checkpoint with the highest well-formed rate among those actually tested for that trial — not necessarily the one with the lowest validation loss (see per-trial notes; the checkpoint with the best val loss and the checkpoint most reliable at the output format are frequently *not* the same checkpoint).

| Trial | Rank / Alpha | Precision | Format | Best checkpoint | `<description>` present | Well-formed (native format) | Within 130 chars | Avg similarity |
|---|---|---|---|---|---|---|---|---|
| 1st | — | — | 4-tag (broken) | — | *not evaluated — superseded before eval tooling existed* | | | |
| 2nd | 32 / 16 | 8-bit | 4-tag | — | *not evaluated — crashed at iter ~2530/3552 before completion* | | | |
| 3rd | 32 / 16 | 4-bit | 4-tag | final (iter 3552) | 68/80 | **52/80** | 68/80 | 0.478 |
| 4th | 16 / 8 | 4-bit | 4-tag | final (iter 3552) | 38/80 | **28/80** | 37/80 | 0.453 |
| 5th | 16 / 8 | 4-bit | 3-tag | checkpoint 900 | 76/80 | **25/80** | 73/80 | 0.485 |
| 6th | 32 / 16 | 4-bit | 3-tag | checkpoint 700 | 63/80 | **12/80** | 61/80 | 0.502 |

**Overall best adapter across all six trials: 5th-trial, checkpoint 900** — best well-formed rate on the 3-tag format, and the format itself is the one actually intended for deployment (no `confidence-reasoning` field).

### Notes on "best" not matching "lowest validation loss"

- **3rd-trial**: checkpoint 700 has the best validation loss (0.779) of any checkpoint in the trial, and gets `<description>`, `<confidence-score>`, and `<review-triggers>` individually correct in the large majority of rows (80/80 has a description; only 1/80 fails on confidence-score or triggers specifically) — but scores only 1/80 *strictly* well-formed, because it drops the `<confidence-reasoning>` tag in the majority of rows. 45/80 rows (56%) are "everything correct except reasoning is simply absent." The final checkpoint (iter 3552), despite being heavily overfit on content, had enough additional training to reliably close out all four tags, which is why it scores highest on strict well-formedness (52/80) even though it's the more memorized/overfit checkpoint.
- **4th-trial**: checkpoints 800/900/1000 (the checkpoints near the validation-loss minimum) collapsed almost completely on structure — checkpoint 900 (best val loss, 0.856) produced a valid `<description>` in only 1/80 rows. Only the final, overfit checkpoint recovered enough structural reliability to be usable (28/80 well-formed). This is the run that motivated dropping `confidence-reasoning` entirely for trials 5 and 6.
- **6th-trial**: unlike 3rd-trial's clean single-tag omission, 6th-trial's failures are messier — wrong tag order and, in some rows, tags that were never part of any trained format at all (`</answer>`, `<explanation>`, HTML-style `<br><b>` tags), suggesting the base model's own default response habits leaking through rather than a clean, isolated defect. This failure mode is present in 5th-trial too but far less often (4/80 rows vs. 17/80 for 6th-trial's best checkpoint) — despite 6th-trial having roughly double the trainable parameters (rank 32 vs. rank 16). More capacity did not translate into better structural reliability here.

---

## 2. Per-Trial Details

### 1st-trial — broken (long in-context style guide)

**Command:**
```bash
python -m mlx_vlm.lora --model-path mlx-community/Qwen3-VL-8B-Instruct-4bit \
  --dataset data/train/ --max-seq-length 4096 --output-path adapters/ \
  --grad-checkpoint --batch-size 1 --image-resize-shape 448 448 --steps-per-save 20
```

**Training data:** used the stock `mlx_vlm.lora` CLI (no validation tracking). The inference/training prompt at this stage restated the *entire* style guide (`prompts/wxdu_alt_text_prompt.txt`, ~10KB) on every example, including a literal filled-in example of the tag structure written as prose (e.g. "for example: `<description>Your description here.</description>`..."). The exact original data files no longer exist on disk (superseded before the export/versioning pipeline was formalized).

**Result:** the fine-tuned model learned to echo the literal placeholder text from the style guide's example verbatim instead of generating new content (template-echoing). Diagnosed as a data/prompt bug, not a model or capacity issue. Never formally evaluated with the current tooling — superseded entirely.

---

### 2nd-trial — 8-bit, rank 32, crashed

**Command:**
```bash
python scripts/train_lora_with_val.py \
  --model-path mlx-community/Qwen3-VL-8B-Instruct-8bit \
  --train-dataset data/train.jsonl --val-dataset data/valid.jsonl \
  --image-resize-shape 448 448 --batch-size 1 --epochs 8 \
  --train-on-completions --max-seq-length 1024 --grad-checkpoint --grad-clip 1.0 \
  --lora-rank 32 --lora-alpha 16 --output-path adapters/
```

**Training data:** first run using the redesigned short prompt (`Generate accessibility alt text for this album cover.\nArtist: {{artist}}\nAlbum title: {{title}}`) paired with the 4-tag assistant output format:
```
<description>...</description>
<confidence-score>0 or 1</confidence-score>
<confidence-reasoning>... or "N/A" if confidence is 1</confidence-reasoning>
<review-triggers>[...]</review-triggers>
```
444 training rows, 80 validation rows.

**Result:** memory climbed steadily over the run (26.9 GB by iter ~110, 28.7 GB by iter ~550), crashing with a Metal OOM error at iteration ~2530/3552. Validation loss reached a minimum of **0.779 at iteration 700** before climbing to 1.254 by the crash point — the first clear overfitting signal in the project. The original log was accidentally truncated to 0 bytes by a `tee` mistake during crash recovery; reconstructed from monitoring notes (`training_logs/2nd-training_run_log.txt`, explicitly labeled as a partial reconstruction). No checkpoint from this run was formally evaluated — the trial was treated as superseded by 3rd-trial (same config, corrected to 4-bit).

---

### 3rd-trial — 4-bit, rank 32, completed

**Command:**
```bash
caffeinate -i python scripts/train_lora_with_val.py \
  --model-path mlx-community/Qwen3-VL-8B-Instruct-4bit \
  --train-dataset data/train.jsonl --val-dataset data/valid.jsonl \
  --image-resize-shape 448 448 --batch-size 1 --epochs 8 \
  --steps-per-report 10 --steps-per-eval 100 --steps-per-save 100 --val-batches -1 \
  --max-seq-length 1024 --grad-checkpoint --grad-clip 1.0 --train-on-completions \
  --assistant-id 77091 --lora-rank 32 --lora-alpha 16 \
  --output-path adapters/3rd-trial \
  2>&1 | tee training_logs/3rd_training_run_log_trial.txt
```

**Training data:** same short prompt + 4-tag format as 2nd-trial, e.g.:
```json
{"messages": [
  {"role": "user", "content": "Generate accessibility alt text for this album cover.\nArtist: Maya Shenfeld\nAlbum title: Under the Sun"},
  {"role": "assistant", "content": "<description>Abstract collage with lines forming a women silhouette and colorful organic shapes  on a dark background.</description>\n<confidence-score>0</confidence-score>\n<confidence-reasoning>The linework forming a possible female silhouette is interwoven with colorful abstract organic shapes, making it difficult to confidently separate the figure's outline from the surrounding decorative forms.</confidence-reasoning>\n<review-triggers>[\"ambiguous main visual element\",\"complex image with mixed media\",\"highly abstract artwork\",\"possible person misidentification\",\"unclear visual focus\"]</review-triggers>"}
]}
```
444 train / 80 valid / 100 train_test rows.

**Result:** completed cleanly, all 3552 iterations, peak memory flat at 24.57 GB. Validation loss minimum **0.789 at iteration 700-800**, climbing to 1.589 by the end — reproducing 2nd-trial's overfitting pattern almost exactly. See §1 notes for the checkpoint-700-vs-final structural tradeoff.

---

### 4th-trial — 4-bit, rank 16, completed

**Command:**
```bash
caffeinate -i python scripts/train_lora_with_val.py \
  --model-path mlx-community/Qwen3-VL-8B-Instruct-4bit \
  --train-dataset data/train.jsonl --val-dataset data/valid.jsonl \
  --image-resize-shape 448 448 --batch-size 1 --epochs 8 \
  --steps-per-report 10 --steps-per-eval 100 --steps-per-save 100 --val-batches -1 \
  --max-seq-length 1024 --grad-checkpoint --grad-clip 1.0 --train-on-completions \
  --assistant-id 77091 --lora-rank 16 --lora-alpha 8 \
  --output-path adapters/4th-trial \
  2>&1 | tee training_logs/4th-training_run_log_trial.txt
```

**Training data:** same 4-tag format as 3rd-trial, but with standardized `confidence_explanation`/`review_triggers` values for 133 rows (via `edited_confidence_explanation`, a rule-based + manually-curated cleanup of `reviews_history` — 131 of those rows had their confidence-reasoning text rewritten from scratch by directly viewing the cover image, since the original human-written text was inconsistent). Same row counts (444/80/100).

**Result:** completed cleanly, peak memory flat at 24.04 GB (barely lower than 3rd-trial's 24.57 GB despite half the rank — LoRA rank turned out not to be the dominant memory factor). Validation loss minimum 0.856 at iteration 900, climbing to 1.572 by the end. Structurally, this run collapsed much harder than 3rd-trial's equivalent checkpoints (see §1) — the leading hypothesis, later acted on, was that the long `confidence-reasoning` field was consuming a disproportionate share of a smaller adapter's learning capacity.

---

### 5th-trial — 4-bit, rank 16, 3-tag format, completed

**Command:**
```bash
caffeinate -i python scripts/train_lora_with_val.py \
  --model-path mlx-community/Qwen3-VL-8B-Instruct-4bit \
  --train-dataset data/train.jsonl --val-dataset data/valid.jsonl \
  --image-resize-shape 448 448 --batch-size 1 --epochs 8 \
  --steps-per-report 10 --steps-per-eval 100 --steps-per-save 100 --val-batches -1 \
  --max-seq-length 1024 --grad-checkpoint --grad-clip 1.0 --train-on-completions \
  --assistant-id 77091 --lora-rank 16 --lora-alpha 8 \
  --output-path adapters/5th-trial \
  2>&1 | tee 5th-training_run_log_trial.txt
```

**Training data:** `confidence-reasoning` removed entirely from `scripts/export_data.js`'s `buildAssistantOutput()`. New assistant format:
```json
{"messages": [
  {"role": "user", "content": "Generate accessibility alt text for this album cover.\nArtist: Akriza & Mah Ze Tar\nAlbum title: Where Are You, Now"},
  {"role": "assistant", "content": "<description>A grand stone temple with an ornate archway under a large light-blue moon; two people play instruments and three dance.</description>\n<confidence-score>1</confidence-score>\n<review-triggers>[]</review-triggers>"}
]}
```
Same 444/80/100 row counts; `scripts/04_generate_alt_text.py`'s structural checker was updated to match the new 3-tag contract at this point.

**Result:** completed cleanly, peak memory flat at 24.04 GB. Validation loss minimum 0.848-0.856 (checkpoints 800-900 essentially tied), climbing to 1.723 by the end — same overall shape as every prior run, but the structural collapse seen in 4th-trial did not recur: checkpoint 900 produced a valid description in 76/80 rows and was well-formed in 25/80, both far above any 4th-trial checkpoint near its own validation minimum. Best adapter across all six trials.

---

### 6th-trial — 4-bit, rank 32, 3-tag format, completed

**Command:**
```bash
caffeinate -i python scripts/train_lora_with_val.py \
  --model-path mlx-community/Qwen3-VL-8B-Instruct-4bit \
  --train-dataset data/train.jsonl --val-dataset data/valid.jsonl \
  --image-resize-shape 448 448 --batch-size 1 --epochs 8 \
  --steps-per-report 10 --steps-per-eval 100 --steps-per-save 100 --val-batches -1 \
  --max-seq-length 1024 --grad-checkpoint --grad-clip 1.0 --train-on-completions \
  --assistant-id 77091 --lora-rank 32 --lora-alpha 16 \
  --output-path adapters/6th-trial \
  2>&1 | tee 6th-training_run_log_trial.txt
```

**Training data:** identical to 5th-trial (3-tag format, 444/80/100 rows). Only the LoRA rank/alpha changed, to test whether rank 32's additional capacity would improve on 5th-trial's still-modest well-formed rate now that the long reasoning field was no longer competing for it.

**Result:** completed cleanly, peak memory flat at 24.57 GB (matching 3rd-trial's rank-32 footprint, higher than the rank-16 runs). Validation loss minimum **0.850 at iteration 500** — noticeably earlier than the rank-16 runs' iteration 800-900 minimum, consistent with rank 32 having more capacity to overfit with. Five checkpoints across the plateau (500/600/700/800/900) were evaluated; best was checkpoint 700 (63/80 description, 12/80 well-formed) — worse than 5th-trial's checkpoint 900 on every measured axis. The hypothesis that more capacity would help, given the field that previously strained rank 16 was gone, was not supported by this run.

---

## 3. Open Questions / Next Steps

- No single trial has produced a consistently well-formed adapter (best rate so far: 25/80, 5th-trial checkpoint 900). The dominant remaining failure mode is the model drifting into non-trained response patterns (wrong tag order, hallucinated tags) rather than a clean, isolated omission.
- 6th-trial's checkpoints 500-900 were evaluated but its final (overfit) checkpoint was not — every prior trial's overfit-final checkpoint scored surprisingly well on structural reliability (3rd: 52/80, 4th: 28/80), so 6th-trial's final adapter is worth testing for comparison before ruling out rank 32 entirely.
- 1st and 2nd trial were never formally evaluated with the current tooling; their inclusion here is for historical completeness, not as data points in the rank/format comparison.
