# Re-Evaluation Report: `repetition_penalty=1.0`

## Background

Every prior evaluation across all six fine-tuning trials (see `fine-tuning-report.md`) used `scripts/04_generate_alt_text.py`'s default generation settings, including `repetition_penalty=1.3`. That value was chosen early in the project to stop degenerate repetition loops in long free-text generation. It was never revisited after the training data format changed to much shorter completions (5th-trial onward).

A manual test on 6th-trial's checkpoint 700 with `repetition_penalty=1.0` (disabled) showed a massive, unexpected improvement, which prompted a full re-evaluation of every checkpoint previously tested. **Conclusion: the repetition penalty was actively breaking tag closure across every trial, and was the dominant confound in essentially all of the rank/format comparisons made earlier in this project.**

## Mechanism

The 3-tag (and 4-tag) output format is inherently repetitive at the character level — e.g. `<description>` and `</description>` share the substring "description" only ~10-15 tokens apart, well inside the `repetition_context_size=20` window. A repetition penalty tuned for long free-text generation penalizes the model for "repeating" a substring that the tag format *requires* it to repeat, actively discouraging correct tag closure. At `repetition_penalty=1.3`, this pushed the model toward malformed output (wrong tag order, hallucinated tags borrowed from the base model's default chat habits — `</answer>`, `<explanation>`, HTML-style `<br><b>` tags) far more often than the training itself was actually failing.

## Full before/after comparison

All 12 checkpoints below were re-run at `repetition_penalty=1.0`, everything else identical to their original evaluation. Results saved to `eval_results/new_tests/{trial}/`.

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

## 3rd-trial deep dive (per-tag breakdown)

3rd-trial and 4th-trial use the native 4-tag format (`description`, `confidence-score`, `confidence-reasoning`, `review-triggers`), so `well_formed` here is computed against that original contract, not the current 3-tag checker.

| Checkpoint | description valid | confidence-score valid | confidence-reasoning present | review-triggers valid | native well-formed |
|---|---|---|---|---|---|
| 700 | 79/80 | 79/80 | 79/80 | 80/80 | **79/80** |
| 800 | 76/80 | 76/80 | 76/80 | 80/80 | 76/80 |
| final | 66/80 | 66/80 | 66/80 | 79/80 | 66/80 |

**This overturns a specific earlier finding.** Under the old decoding settings, checkpoint 700's defect was that `confidence-reasoning` was absent in the majority of rows (34/80 present). Under corrected decoding, `confidence-reasoning` is present in 79/80 rows — matching every other field almost exactly. The "checkpoint 700 systematically drops the reasoning tag" conclusion, reached earlier in this project and one of the reasons `confidence-reasoning` was dropped from the training format for 5th/6th-trial, was itself a repetition-penalty artifact, not a real training/capacity limitation.

## Why improvement size varies by trial

| Trial | Rank | Format | Improvement range | Best achieved |
|---|---|---|---|---|
| 3rd | 32 | 4-tag (long) | +14 to +78 | 79/80 |
| 5th | 16 | 3-tag (short) | +19 to +49 | 74/80 |
| 6th | 32 | 3-tag (short) | +13 to +35 | 47/80 |
| 4th | 16 | 4-tag (long) | +3 | 31/80 |

Repetition penalty was the dominant confound for the two combinations that had real underlying capacity-to-task match (3rd: high capacity/long task, 5th: low capacity/short task). It was not the whole story for the two mismatched combinations (6th: high capacity/short task, 4th: low capacity/long task) — both still underperform substantially even after correction. This suggests **rank should be matched to format complexity**: too much capacity for a short target, or too little for a long one, both hurt independent of decoding settings.

## Revised ranking, all trials

1. **3rd-trial, checkpoint 700 — 79/80 well-formed, val loss 0.779.** New best adapter overall, by a wide margin. Includes `confidence-reasoning`.
2. **5th-trial, checkpoint 900 — 74/80 well-formed, val loss 0.856.** Close second.
3. 6th-trial, checkpoint 700 — 47/80.
4. 6th-trial, final — 44/80.
5. 4th-trial, final — 31/80. Weakest of the four fully-trained configurations even after correction.

## Implications

- The decision to drop `confidence-reasoning` after 4th-trial was made on confounded evidence. 4th-trial's structural collapse was real even after correction (31/80 best), but that's specific to rank 16 being unable to handle that much content — not evidence the reasoning field itself is unlearnable. 3rd-trial proves it's learnable near-perfectly at rank 32.
- 3rd-trial-700 may already be usable as-is: 79/80 well-formed, good validation loss, produces all four fields including reasoning, required no new training.
- Any further trial should be motivated by the corrected picture, not the original (confounded) one — see "Next Steps."

## Next Steps

Planned: **7th-trial** — rank 32 / alpha 16 (matching 3rd-trial's scale), `confidence-reasoning` reintroduced into the training data. This is not a pure repeat of 3rd-trial: the training data now uses the standardized `confidence_explanation` text from `edited_confidence_explanation` (133 rows rewritten/cleaned after 3rd-trial ran), rather than the original unstandardized text 3rd-trial was trained on. This tests whether the cleaner reasoning text improves further on 3rd-trial-700's already-strong result.
