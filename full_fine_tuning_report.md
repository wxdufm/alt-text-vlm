# Full Fine-Tuning Report: Album-Cover Alt-Text Generation

This is the complete record of fine-tuning `mlx-community/Qwen3-VL-8B-Instruct-4bit`
(8-bit for one trial) to generate WCAG 2.2-compliant album-cover alt text. It covers seven
trials, two output formats, one major decoding bug, and one retroactive re-evaluation of
everything.

**A note on numbers:** two evaluation passes exist for most checkpoints — an original pass run
at `repetition_penalty=1.3`, and a corrected pass at `repetition_penalty=1.0` after a major
confound was discovered (§4). Every number in the main body of this report uses the **corrected**
`repetition_penalty=1.0` figures unless explicitly labeled "old"/"pre-correction." The original,
superseded numbers are preserved in Appendix B for historical reference — they were the basis for
real decisions made mid-project (e.g. dropping `confidence-reasoning` after 4th-trial) and are
worth keeping visible even though they turned out to be misleading.

## 1. What this project is for

Per `context.md`: the goal is a repository of alt text for album-cover artwork, useful to
low-vision and blind listeners across any music application (review sites, now-playing
interfaces, etc.), conforming to WCAG 2.2 1.1.1. The plan has three stages — (1) generate a
~500-pair human-verified training set from WXDU's release database, (2) fine-tune a local VLM
until it produces conforming alt text in **at least 95% of cases**, (3) deploy it across WXDU's
full catalog (~50,000 covers with a Discogs ID). This report is entirely Stage 2: seven attempts
at that 95% target, all trained locally on Apple Silicon via `scripts/train_lora_with_val.py`, a
custom trainer built on `mlx_vlm` that adds real validation-loss tracking (the stock
`mlx_vlm.lora` CLI silently ignores `--val-dataset`).

## 2. All seven trials at a glance (corrected numbers)

Every number below is the trial's best checkpoint, scored on the same 80-row `data/valid.jsonl`
holdout with `scripts/04_generate_alt_text.py` at `repetition_penalty=1.0` — the corrected
setting (see §4). "Well-formed" means every required tag is present, correctly closed, and
individually valid (a real confidence score, a valid JSON list of triggers).

| Trial | Base precision | Rank / α | Output format | Best checkpoint | Val loss (min) | Well-formed | Within 130 char | Avg. similarity |
|---|---|---|---|---|---|---|---|---|
| 1st | 4-bit | 8 / 16 | long in-context style guide (broken) | final (only save) | not tracked | **0/80 (0%)** | 0/80 (0%) | 0.000 |
| 2nd | **8-bit** | 32 / 16 | 4-tag | checkpoint 700 | 0.779 @700 | **78/80 (97.5%)** | 69/80 (86.3%) | 0.496 |
| 3rd | 4-bit | 32 / 16 | 4-tag | checkpoint 700 | 0.789 @700–800 | **79/80 (98.8%)** | 73/80 (91.3%) | 0.488 |
| 4th | 4-bit | 16 / 8 | 4-tag (standardized reasoning, 133 rows) | final (iter 3552) | 0.856 @900 | 31/80 (38.8%) | 31/80 (38.8%) | 0.477 |
| 5th | 4-bit | 16 / 8 | 3-tag | checkpoint 900 | 0.848–0.856 @800–900 | 74/80 (92.5%) | 72/80 (90.0%) | 0.504 |
| 6th | 4-bit | 32 / 16 | 3-tag | checkpoint 700 | 0.850 @500 | 47/80 (58.8%) | 45/80 (56.3%) | 0.517 |
| 7th | 4-bit | 32 / 16 | 4-tag (standardized reasoning, all rows) | checkpoint 800 | 0.852 @800 | **76/80 (95.0%)** | 74/80 (92.5%) | 0.488 |

**Overall best: 3rd-trial, checkpoint 700 — 79/80 (98.8%) well-formed**, with 2nd-trial-700 and
7th-trial-800 close behind. All three sit right at the project's 95% target from Stage 2 of
`context.md`; three others (1st, 4th, 6th) fall well short.

Two output formats were used across these trials:
- **4-tag** (1st\*, 2nd, 3rd, 4th, 7th): `<description>`, `<confidence-score>`,
  `<confidence-reasoning>`, `<review-triggers>`
- **3-tag** (5th, 6th): `<description>`, `<confidence-score>`, `<review-triggers>` —
  `confidence-reasoning` dropped for these two trials only, then reinstated for 7th.

\* 1st-trial's format wasn't tag-based at all — see §3.

## 3. The story, in order

### Before trial 1 — the data and the style guide

Training data was built from WXDU's release database: artist, album title, and a target
alt-text output, exported via `scripts/export_data.js`. The original prompt setup restated the
*entire* style guide (`prompts/wxdu_alt_text_prompt.txt`, ~10KB) on every training example,
including a literal filled-in example of the tag structure written as prose.

### 1st trial — broken by its own prompt

**Command:**
```bash
python -m mlx_vlm.lora --model-path mlx-community/Qwen3-VL-8B-Instruct-4bit \
  --dataset data/train/ --max-seq-length 4096 --output-path adapters/ \
  --grad-checkpoint --batch-size 1 --image-resize-shape 448 448 --steps-per-save 20
```

Trained with the stock `mlx_vlm.lora` CLI (no validation tracking) on the long in-context
prompt above, rank 8 / α 16 — the only trial with a >1 alpha-to-rank ratio; every later trial
used α = 0.5×rank. The model learned to echo the literal placeholder text from the style guide's
worked example instead of generating new content — a data/prompt bug, not a capacity problem.
Diagnosed at the time and never formally evaluated; the original training files no longer exist
(this predates the export/versioning pipeline). Every trial since has used a short, two-line
prompt instead:
`Generate accessibility alt text for this album cover.\nArtist: {artist}\nAlbum title: {title}`.

**Retroactively evaluated for this report** (§6) against the current 80-row holdout: 0/80 on
every metric, because the model was never taught this shorter prompt's tag contract at all. Not
a repeat of the original bug — a different failure mode entirely (see §6).

### 2nd trial — the redesigned prompt, 8-bit, and a crash

**Command:**
```bash
python scripts/train_lora_with_val.py \
  --model-path mlx-community/Qwen3-VL-8B-Instruct-8bit \
  --train-dataset data/train.jsonl --val-dataset data/valid.jsonl \
  --image-resize-shape 448 448 --batch-size 1 --epochs 8 \
  --train-on-completions --max-seq-length 1024 --grad-checkpoint --grad-clip 1.0 \
  --lora-rank 32 --lora-alpha 16 --output-path adapters/
```

First run with the new short prompt and the 4-tag format, 8-bit base model, rank 32 / α 16:
```
<description>...</description>
<confidence-score>0 or 1</confidence-score>
<confidence-reasoning>... or "N/A" if confidence is 1</confidence-reasoning>
<review-triggers>[...]</review-triggers>
```
444 training rows, 80 validation rows. Memory climbed steadily (26.9 GB by iter ~110, 28.7 GB by
iter ~550) and the run crashed with a Metal OOM at iteration ~2530/3552. Validation loss bottomed
out at **0.779 at iteration 700** before climbing to 1.254 by the crash point — the project's
first clear overfitting signal. The training log was accidentally truncated to 0 bytes during
crash recovery; `training_logs/2nd-training_run_log.txt` is a reconstruction from monitoring
notes. No checkpoint was evaluated at the time — the trial was treated as fully superseded by
3rd-trial (same config, corrected to 4-bit). This turned out to be a mistake (§6): checkpoint 700
sat on disk the whole time and is the project's #2 adapter once actually scored.

### 3rd trial — the first complete run

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

Same config as 2nd-trial, switched to the 4-bit base model. Training data example:
```json
{"messages": [
  {"role": "user", "content": "Generate accessibility alt text for this album cover.\nArtist: Maya Shenfeld\nAlbum title: Under the Sun"},
  {"role": "assistant", "content": "<description>Abstract collage with lines forming a women silhouette and colorful organic shapes  on a dark background.</description>\n<confidence-score>0</confidence-score>\n<confidence-reasoning>The linework forming a possible female silhouette is interwoven with colorful abstract organic shapes, making it difficult to confidently separate the figure's outline from the surrounding decorative forms.</confidence-reasoning>\n<review-triggers>[\"ambiguous main visual element\",\"complex image with mixed media\",\"highly abstract artwork\",\"possible person misidentification\",\"unclear visual focus\"]</review-triggers>"}
]}
```
444 train / 80 valid / 100 train_test rows. Completed cleanly, all 3552 iterations, peak memory
flat at 24.57 GB. Validation loss minimum **0.789 at iteration 700–800**, climbing to 1.589 by the
end — the same overfitting shape as 2nd-trial. This is the best adapter across all seven trials.

### 4th trial — standardized reasoning text, half the rank

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

Same 4-tag format, but 133 rows had their `confidence-reasoning` text rewritten from scratch
(rule-based cleanup plus manual review of the source cover image, via `edited_confidence_explanation`,
replacing inconsistent human-written text). Rank halved to 16 / α 8 to test a smaller adapter.
Peak memory barely changed (24.04 GB vs 3rd-trial's 24.57 GB — rank turned out not to be the
dominant memory cost). Validation loss minimum 0.856 at iteration 900, but checkpoints near that
minimum **collapsed structurally** — checkpoint 900 produced a valid `<description>` in only 1/80
rows at the time (pre-correction number; see Appendix B). Only the final, overfit checkpoint
recovered enough reliability to be usable. This result motivated dropping `confidence-reasoning`
for the next two trials, on the hypothesis that the long reasoning field was consuming a
disproportionate share of a smaller adapter's capacity — a hypothesis later shown to be based on
confounded evidence (§4).

### 5th trial — 3-tag format, rank 16

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

`confidence-reasoning` removed entirely from `scripts/export_data.js`'s `buildAssistantOutput()`.
New assistant format:
```json
{"messages": [
  {"role": "user", "content": "Generate accessibility alt text for this album cover.\nArtist: Akriza & Mah Ze Tar\nAlbum title: Where Are You, Now"},
  {"role": "assistant", "content": "<description>A grand stone temple with an ornate archway under a large light-blue moon; two people play instruments and three dance.</description>\n<confidence-score>1</confidence-score>\n<review-triggers>[]</review-triggers>"}
]}
```
Same rank 16 / α 8, same 444/80/100 row counts. Completed cleanly, peak memory 24.04 GB.
Validation loss minimum 0.848–0.856 (checkpoints 800–900 essentially tied). Structural collapse
did **not** recur — checkpoint 900 produced a valid description in 76/80 rows, far above any
4th-trial checkpoint near its own minimum. At the time (pre-correction), this was judged the best
adapter yet.

### 6th trial — 3-tag format, rank 32

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

Identical to 5th-trial except rank doubled to 32 / α 16, testing whether more capacity would help
now that the long reasoning field was gone. Peak memory back up to 24.57 GB (matching the rank-32
trials). Validation loss minimum **0.850 at iteration 500** — notably earlier than the rank-16
runs' 800–900, consistent with more capacity overfitting faster. At the time, best checkpoint
(700) scored only 12/80 well-formed (pre-correction) — worse than 5th-trial on every axis. More
capacity did not help; see §4 for why.

### The `repetition_penalty` bug (the turning point)

Every prior evaluation across all six fine-tuning trials used `scripts/04_generate_alt_text.py`'s
default generation settings, including `repetition_penalty=1.3`. That value was chosen early in
the project to stop degenerate repetition loops in long free-text generation. It was never
revisited after the training data format changed to much shorter completions (5th-trial onward).

A manual test on 6th-trial's checkpoint 700 with `repetition_penalty=1.0` (disabled) showed a
massive, unexpected improvement, which prompted a full re-evaluation of every checkpoint
previously tested. **Conclusion: the repetition penalty was actively breaking tag closure across
every trial, and was the dominant confound in essentially all of the rank/format comparisons made
earlier in this project.**

**Why:** the 3-tag/4-tag output format is inherently repetitive at the character level —
`<description>` and `</description>` share the substring "description" only ~10–15 tokens apart,
well inside the `repetition_context_size=20` window. A repetition penalty tuned for long
free-text generation actively penalizes the model for "repeating" a substring the tag format
*requires* it to repeat, pushing output toward malformed structure (wrong tag order, hallucinated
tags borrowed from the base model's own chat habits — `</answer>`, `<explanation>`, HTML-style
`<br><b>` tags) far more often than the training itself was actually failing. This one setting
was the dominant confound in essentially every rank/format comparison made up to this point —
including the specific conclusion (3rd-trial-700 systematically drops `confidence-reasoning`)
that motivated dropping the field for 5th/6th-trial in the first place. Under corrected decoding,
3rd-trial-700 produces `confidence-reasoning` in 79/80 rows, matching every other field almost
exactly.

`repetition_penalty=1.0` is now the script default (`scripts/04_generate_alt_text.py`) and every
number in §2 reflects it.

#### Full before/after comparison

All 12 checkpoints below were re-run at `repetition_penalty=1.0`, everything else identical to
their original evaluation. Results saved to `eval_results/new_tests/{trial}/`.

| Checkpoint | Format | Old well-formed (rep-penalty 1.3) | **New well-formed (rep-penalty 1.0)** | Change |
|---|---|---|---|---|
| 3rd-final | 4-tag | 52/80 | 66/80 | +14 |
| **3rd-700** | 4-tag | 1/80 | **79/80** | **+78** |
| 3rd-800 | 4-tag | 17/80 | 76/80 | +59 |
| 4th-final | 4-tag | 28/80 | 31/80 | +3 |
| **5th-900** | 3-tag | 25/80 | **74/80** | **+49** |
| 5th-final | 3-tag | 18/80 | 37/80 | +19 |
| 6th-500 | 3-tag | 0/80 | 13/80 | +13 |
| 6th-600 | 3-tag | 8/80 | 41/80 | +33 |
| 6th-700 | 3-tag | 12/80 | 47/80 | +35 |
| 6th-800 | 3-tag | 7/80 | 32/80 | +25 |
| 6th-900 | 3-tag | 9/80 | 40/80 | +31 |
| 6th-final | 3-tag | *(untested before)* | 44/80 | new |

Every checkpoint improved; none got worse.

#### 3rd-trial deep dive (per-tag breakdown)

3rd-trial and 4th-trial use the native 4-tag format, so `well_formed` here is computed against
that original contract.

| Checkpoint | description valid | confidence-score valid | confidence-reasoning present | review-triggers valid | native well-formed |
|---|---|---|---|---|---|
| 700 | 79/80 | 79/80 | 79/80 | 80/80 | **79/80** |
| 800 | 76/80 | 76/80 | 76/80 | 80/80 | 76/80 |
| final | 66/80 | 66/80 | 66/80 | 79/80 | 66/80 |

**This overturned a specific earlier finding.** Under the old decoding settings, checkpoint 700's
defect appeared to be that `confidence-reasoning` was absent in the majority of rows (34/80
present). Under corrected decoding, `confidence-reasoning` is present in 79/80 rows — matching
every other field almost exactly. The "checkpoint 700 systematically drops the reasoning tag"
conclusion, one of the reasons `confidence-reasoning` was dropped from the training format for
5th/6th-trial, was itself a repetition-penalty artifact, not a real training/capacity limitation.

#### Why improvement size varies by trial

| Trial | Rank | Format | Improvement range | Best achieved |
|---|---|---|---|---|
| 3rd | 32 | 4-tag (long) | +14 to +78 | 79/80 |
| 5th | 16 | 3-tag (short) | +19 to +49 | 74/80 |
| 6th | 32 | 3-tag (short) | +13 to +35 | 47/80 |
| 4th | 16 | 4-tag (long) | +3 | 31/80 |

Repetition penalty was the dominant confound for the two combinations that had real underlying
capacity-to-task match (3rd: high capacity/long task, 5th: low capacity/short task). It was not
the whole story for the two mismatched combinations (6th: high capacity/short task, 4th: low
capacity/long task) — both still underperform substantially even after correction. This is the
first appearance of the "rank should match format complexity" pattern developed fully in §4.

### 7th trial — reintroducing reasoning, now correctly measured

**Command:**
```bash
caffeinate -i python scripts/train_lora_with_val.py \
  --model-path mlx-community/Qwen3-VL-8B-Instruct-4bit \
  --train-dataset data/train.jsonl \
  --val-dataset data/valid.jsonl \
  --image-resize-shape 448 448 \
  --batch-size 1 \
  --epochs 8 \
  --steps-per-report 10 \
  --steps-per-eval 100 \
  --steps-per-save 100 \
  --val-batches -1 \
  --max-seq-length 1024 \
  --grad-checkpoint \
  --grad-clip 1.0 \
  --train-on-completions \
  --assistant-id 77091 \
  --lora-rank 32 \
  --lora-alpha 16 \
  --output-path adapters/7th-trial \
  2>&1 | tee 7th-training_run_log_trial.txt
```

Since 3rd-trial proved `confidence-reasoning` is learnable near-perfectly at rank 32 once
decoding is fixed, 7th-trial reintroduced it: rank 32 / α 16 (matching 3rd-trial's scale), 4-tag
format, but trained on the *standardized* `confidence_explanation` text from 4th-trial's cleanup
(133 rewritten rows) rather than the original unstandardized text 3rd-trial saw. Peak memory
24.57 GB, consistent with every other rank-32 run. Validation loss minimum **0.852 at iteration
800** (700 and 900 essentially tied at 0.855/0.857), climbing to 1.734 by the final checkpoint
(iter 3552) — the same overfitting shape as every prior rank-32 run, just with the minimum
arriving slightly later.

Checkpoints 800, 900, and final were all evaluated:

| Checkpoint | Val loss | Well-formed | Within 130 char | Avg similarity |
|---|---|---|---|---|
| **800** | 0.852 | **76/80 (95.0%)** | **74/80 (92.5%)** | 0.488 |
| 900 | 0.857 | 77/80 (96.3%) | 70/80 (87.5%) | 0.501 |
| final | 1.734 | 60/80 (75.0%) | 69/80 (86.3%) | 0.459 |

**Checkpoint 800 is the pick**: it's the val-loss-minimum checkpoint, and although 900 edges it
out on raw well-formed rate (77 vs 76), 800 leads on the within-130-char rate that matters most
for deployment (74/80 vs 70/80). `final` collapses as expected under heavy overfitting (train
loss ~0.06 by the end) — not usable.

A granular per-tag check on checkpoint 900 confirmed the failures are total (all four tags
missing together in the 3 bad rows), not isolated single-tag defects — matching 3rd-trial's
pattern exactly (77/80 all-four-correct vs 77/80 well-formed). It also confirmed the model
learned the confidence-conditioned field logic perfectly: of the 77 well-formed rows, all 4
confidence=0 rows have non-empty `confidence-reasoning` and non-empty `review-triggers`, and all
73 confidence=1 rows have `confidence-reasoning` = `"N/A"` and `review-triggers` = `[]`, with zero
exceptions — matching both the training data's construction logic (`export_data.js`) and the
style guide's definition of the confidence score.

This confirms the corrected 3rd-trial result rather than improving on it — the cleaner reasoning
text didn't move the needle much, which itself is informative (see §5).

## 4. Full comparison, and the two shapes of failure

Ranking every trial's best checkpoint by well-formed rate:

| Rank | Trial | Well-formed | Note |
|---|---|---|---|
| 1 | 3rd (ckpt 700) | 79/80 | rank 32, matched to 4-tag's length |
| 2 | 2nd (ckpt 700) | 78/80 | same match, 8-bit base; never scored until this report |
| 3 | 7th (ckpt 800) | 76/80 | same match, standardized reasoning text |
| 4 | 5th (ckpt 900) | 74/80 | rank 16, matched to 3-tag's shorter length |
| 5 | 6th (ckpt 700) | 47/80 | rank 32 **mismatched** to 3-tag's shorter length |
| 6 | 4th (final) | 31/80 | rank 16 **mismatched** to 4-tag's longer length |
| 7 | 1st (final) | 0/80 | different prompt format entirely, not comparable |

The four fully-evaluated 4-tag/3-tag trials split cleanly into two groups: 3rd, 2nd, 5th, and 7th
all pair adapter capacity with the format's actual length (rank 32 for the longer 4-tag format
with reasoning; rank 16 for the shorter 3-tag format) and all land at 92%+ well-formed. 4th and
6th invert that pairing — rank 16 on the long format, rank 32 on the short one — and both
underperform substantially even after the decoding fix. **LoRA rank should be matched to output
length/complexity, not maximized or minimized independent of the target format.**

Text similarity to the human-written reference tells a different, much flatter story: every
trial that produces a description at all lands in a tight 0.459–0.517 band, regardless of
well-formed rate. 6th-trial has middling structural compliance (58.8%, second-worst of the six
comparable trials) but the *best* similarity score (0.517) of any trial — while 3rd-trial, the
best-structured adapter of the project (98.8%), has below-median similarity (0.488). Description
quality and structural compliance are apparently close to independent — one is about whether the
model can format its answer, the other about whether it looked at the image carefully. Fixing
one doesn't move the other.

## 5. Lessons learned, in priority order

1. **Decoding parameters can dominate every other variable.** `repetition_penalty` alone was a
   bigger lever than base-model precision, LoRA rank, or the reasoning-field format decision
   combined — it silently made two of the earliest usable checkpoints (3rd-700, 6th-700) look
   like near-total failures, and drove the decision to remove `confidence-reasoning` from the
   format on confounded evidence. Any generation-quality regression should be checked against
   decoding settings before touching training.
2. **Match LoRA rank to the target's length, not "more is always better."** See §4 — this is
   the cleanest, most reproducible finding of the whole project.
3. **A crashed training run is not necessarily a bad one.** 2nd-trial was written off entirely
   for four trials' worth of iteration because it crashed near the end. Its checkpoint 700 —
   saved ~1,800 iterations before the crash — is the project's #2 adapter. The failure mode
   (Metal OOM late in a long run) had nothing to do with the quality of checkpoints saved
   earlier.
4. **`confidence-reasoning` is learnable at sufficient capacity.** The field that "broke"
   4th-trial (rank 16) is reproduced near-perfectly by every rank-32 trial that includes it
   (3rd, 7th). The standardized/cleaned version of the reasoning text used in 7th-trial didn't
   meaningfully outperform 3rd-trial's original text — cleanup of that specific field wasn't the
   lever that mattered.
5. **Structural well-formedness and content quality are close to independent.** Optimizing one
   doesn't move the other; both need to be checked, and neither substitutes for the other.

## 6. Retroactive evaluation of 1st and 2nd trial

Both predate `scripts/04_generate_alt_text.py` and were never formally scored. For this report,
both trials' best available adapters were run through the current eval tooling (same 80-row
holdout, `repetition_penalty=1.0`) so all seven trials could sit on one basis.

- **2nd-trial, checkpoint 700** (the val-loss-minimum checkpoint, saved well before the crash):
  **78/80 well-formed** — the project's #2 result, requiring no new training, sitting on disk
  the entire time.
- **1st-trial, final** (only checkpoint saved): 0/80 on every metric, but not a repeat of the
  original template-echoing bug — it's a genuine prompt-format mismatch, since 1st-trial was
  trained on the long-since-replaced in-context style guide prompt, not the short prompt every
  later trial (and the current holdout set) uses. Raw output splits into two failure modes:
  62/80 rows are plain, untagged prose that is often coherent and on-topic (just not in this
  pipeline's trained format); 18/80 rows are degenerate token-repetition loops running to the
  256-token cutoff. 1st-trial's rank/α (8/16) also stands out as the only trial with a >1
  alpha-to-rank ratio — every later trial used 0.5 — though given the prompt mismatch this
  wasn't tested as a variable in its own right.

## 7. Current recommendation

**Deploy 3rd-trial, checkpoint 700** (`adapters/3rd-trial/700/`): rank 32 / α 16, 4-bit base,
4-tag format including `confidence-reasoning`, 79/80 (98.8%) well-formed, val loss 0.779, no new
training required. It clears the Stage 2 target from `context.md` (≥95% conforming output) with
room to spare.

**2nd-trial, checkpoint 700** (`adapters/2nd-trial/700/`, reconstructed for this report from
`adapters/2nd-trial/0000700_adapters.safetensors`) is a close second at 97.5% and worth keeping
as a fallback/comparison — it's trained on the 8-bit base model, which may matter for deployment
memory/speed at the ~50,000-image Stage 3 scale.

7th-trial (95.0%) is the most "up to date" adapter — same scale as 3rd-trial, trained on
standardized reasoning text — but doesn't beat 3rd-trial's original result, so there's no
evidence-based reason to prefer it over 3rd-trial-700 specifically.

## 8. Open questions / next steps

- **Within-130-char rate lags well-formed rate everywhere** (e.g. 3rd-trial: 98.8% well-formed
  vs. 91.3% within-limit). No trial has specifically targeted description length; this is the
  most likely next lever if the deployment target requires strict adherence to the 130-character
  cap rather than just well-formed tags.
- **Similarity is flat across every trial (~0.46–0.52)** regardless of every other change made —
  format, rank, base precision, decoding fix. This suggests the ceiling on description *content*
  quality (as opposed to structure) is set by something not yet varied across these seven trials
  — training-data quality/coverage being the most likely candidate.
- **1st-trial's rank/α ratio (8/16, i.e. α = 2×rank) was never tested as a deliberate variable**
  on a working prompt format — every subsequent trial used α = 0.5×rank. Given time, worth a
  clean comparison at matched rank to rule in/out.
- No trial has yet been run against a held-out set outside `data/valid.jsonl`'s 80 rows, or
  against the eventual Stage 3 deployment distribution (WXDU covers with a Discogs ID) — the 95%
  target in `context.md` is being measured on the same 80 rows every adapter was also
  checkpoint-selected against, which is optimistic relative to true generalization.

---

## Appendix A: evaluation methodology notes

All original (pre-correction) evaluations were run with `scripts/04_generate_alt_text.py`
against the 80-row `data/valid.jsonl` validation set. Before the format-agnostic checker existed,
`is_well_formed()` was checked against **each trial's own native format** — trials 1–4 against
the 4-tag contract, trials 5–6 against the 3-tag contract, with the regex manually updated when
the trained format changed after trial 4. The checker was later rewritten to try both formats
automatically (`STRUCTURE_RE_WITH_REASONING` / `STRUCTURE_RE_NO_REASONING`), removing the need for
manual toggling and making cross-trial comparison in §2 and §4 possible on one consistent basis.

"Best" checkpoint per trial was originally defined as the checkpoint with the highest well-formed
rate among those actually tested — not necessarily the one with the lowest validation loss, since
those were frequently not the same checkpoint (most visibly in 3rd- and 4th-trial pre-correction,
where the checkpoints nearest the validation-loss minimum had the worst structural compliance).
Post-correction, this divergence mostly disappeared — see Appendix B vs. §2.

## Appendix B: original (pre-correction) results, `repetition_penalty=1.3`

Preserved for historical reference. These are the numbers that were actually used to make
decisions mid-project (notably: dropping `confidence-reasoning` after 4th-trial). They are
superseded by §2/§4 and should not be used for any new decision-making.

| Trial | Rank / Alpha | Precision | Format | Best checkpoint (by old eval) | `<description>` present | Well-formed (native format) | Within 130 chars | Avg similarity |
|---|---|---|---|---|---|---|---|---|
| 1st | 8 / 16 | 4-bit | 4-tag (broken) | — | *not evaluated — superseded before eval tooling existed* | | | |
| 2nd | 32 / 16 | 8-bit | 4-tag | — | *not evaluated — crashed at iter ~2530/3552 before completion* | | | |
| 3rd | 32 / 16 | 4-bit | 4-tag | final (iter 3552) | 68/80 | **52/80** | 68/80 | 0.478 |
| 4th | 16 / 8 | 4-bit | 4-tag | final (iter 3552) | 38/80 | **28/80** | 37/80 | 0.453 |
| 5th | 16 / 8 | 4-bit | 3-tag | checkpoint 900 | 76/80 | **25/80** | 73/80 | 0.485 |
| 6th | 32 / 16 | 4-bit | 3-tag | checkpoint 700 | 63/80 | **12/80** | 61/80 | 0.502 |

At the time, this table implied "5th-trial, checkpoint 900" was the overall best adapter, and
that 3rd-trial-700 (val loss 0.779, the best of any checkpoint in the project at the time)
"dropped `confidence-reasoning` in the majority of rows" (45/80 rows had everything else correct
but no reasoning tag) — the specific finding that motivated 5th/6th-trial's 3-tag format in the
first place. Both conclusions were reversed once `repetition_penalty` was corrected (§4):
3rd-trial-700 turned out to be the best adapter in the project, and its apparent
`confidence-reasoning` omission was a decoding artifact, not a training limitation.

Per-trial notes on "best" not matching "lowest validation loss" (pre-correction):

- **3rd-trial**: checkpoint 700 had the best validation loss (0.779) of any checkpoint in the
  trial, and got `<description>`, `<confidence-score>`, and `<review-triggers>` individually
  correct in the large majority of rows — but scored only 1/80 *strictly* well-formed under the
  old decoding settings, because it appeared to drop the `<confidence-reasoning>` tag in the
  majority of rows. The final checkpoint (iter 3552), despite being heavily overfit on content,
  had enough additional training to reliably close out all four tags under those settings, which
  is why it scored highest on strict well-formedness (52/80) pre-correction even though it's the
  more memorized/overfit checkpoint.
- **4th-trial**: checkpoints 800/900/1000 (near the validation-loss minimum) collapsed almost
  completely on structure under the old settings — checkpoint 900 (best val loss, 0.856) produced
  a valid `<description>` in only 1/80 rows. Only the final, overfit checkpoint recovered enough
  structural reliability to be usable (28/80 well-formed). This is the run that motivated
  dropping `confidence-reasoning` entirely for trials 5 and 6.
- **6th-trial**: unlike 3rd-trial's clean single-tag omission, 6th-trial's pre-correction failures
  were messier — wrong tag order and, in some rows, tags that were never part of any trained
  format at all (`</answer>`, `<explanation>`, HTML-style `<br><b>` tags), suggesting the base
  model's own default response habits leaking through rather than a clean, isolated defect. This
  failure mode was present in 5th-trial too but far less often (4/80 rows vs. 17/80 for
  6th-trial's best checkpoint) — despite 6th-trial having roughly double the trainable parameters
  (rank 32 vs. rank 16). More capacity did not translate into better structural reliability under
  the old (confounded) measurement, and — per §4 — only partially did even after correction.
