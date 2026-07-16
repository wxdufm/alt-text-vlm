# 1st & 2nd Trial: Retroactive Evaluation

Both trials predate `scripts/04_generate_alt_text.py` and were never formally scored (see
`fine-tuning-report.md` §2). This report runs each trial's best available adapter through the
current eval tooling — same 80-row `data/valid.jsonl`, same `repetition_penalty=1.0` used for
every other trial's corrected numbers in `new_test_report.md` — so all seven trials can sit on
one chart.

## Results

| Trial | Best adapter | Base model | Rank / α | Well-formed | Within 130 char | Avg. similarity |
|---|---|---|---|---|---|---|
| 1st | final (only checkpoint saved) | 4-bit | 8 / — (scale 2.0) | **0/80** | 0/80 | 0.000 |
| 2nd | checkpoint 700 (val-loss min, 0.779) | **8-bit** | 32 / 16 | **78/80** | 69/80 | 0.496 |

Full predictions: `eval_results/1st-trial/1st-final.jsonl`, `eval_results/2nd-trial/2nd-700.jsonl`.

## 2nd-trial — the run that crashed turns out to be the strongest early checkpoint

2nd-trial was 3rd-trial's config run on the 8-bit base model instead of 4-bit, and it crashed
from a Metal OOM at iteration ~2530/3552 before ever being scored (see `fine-tuning-report.md`).
Its checkpoint 700 — the one nearest the validation-loss minimum — was never tested at the time.

Re-run today at `repetition_penalty=1.0`: **78/80 well-formed, 0.496 avg similarity** — on par
with 3rd-trial-700 (79/80, 0.488) and 7th-trial-900 (77/80, 0.501), the two current top
performers. The crash that ended this run happened ~1800 iterations after this checkpoint was
saved; the checkpoint itself was never the problem. This is a genuinely strong adapter that
existed on disk the entire time and was simply never evaluated because the run's overall
narrative ("crashed, superseded by 3rd-trial") never got revisited once the eval tooling and
`repetition_penalty` fix arrived.

## 1st-trial — 0/80 is a prompt-format mismatch, not a re-confirmation of the original bug

1st-trial was trained on a completely different, ~10KB in-context style-guide prompt that
restated the full instructions (including a literal filled-in tag example) on every example —
the setup that produced the original "template-echoing" bug described in `fine-tuning-report.md`.
That prompt format was replaced starting with 2nd-trial by the short two-line prompt
`data/valid.jsonl` uses today. Running 1st-trial's adapter against the current short prompt is
not a repeat of the original evaluation — it's testing the adapter against a prompt it never
saw during training.

Every one of the 80 rows scores 0 because `is_well_formed()`/`extract_description()` require a
literal `<description>` tag, and none of 1st-trial's output contains one — the model was never
taught this prompt's tag contract, so structurally the model can't score. But the raw text
(`prediction_raw` in the jsonl) splits into two distinct failure modes:

- **62/80 rows**: plain, untagged prose — often a coherent, on-topic description. E.g. for
  *Flooding*: `"Dark brown background with a vertical yellow-green blur on the left side. White
  text in the center reads "Flooding"..."` — genuinely usable content, just not in the trained
  format for this pipeline.
- **18/80 rows**: degenerate repetition loops that run to the 256-token cutoff — e.g.
  `"SnowmanSnowmanSnowmanSnowman..."` or `"Album cover image by Jeremiah Chiu. Album cover image
  by Jeremiah Chiu. ..."`. This is the same failure class the original template-echoing bug
  produced, just a different literal template.

So 1st-trial's 0/80 is real (it cannot currently produce this pipeline's tag format at all,
which is the metric that matters for deployment) but it overstates how "broken" the model is —
roughly three-quarters of its output is legible, relevant text that a differently-shaped
evaluator would score.

## How this changes the standings

Well-formed rate, best adapter per trial, all seven now on one basis:

| Rank | Trial | Well-formed |
|---|---|---|
| 1 | 3rd (ckpt 700) | 79/80 |
| 2 | **2nd (ckpt 700)** | **78/80** |
| 3 | 7th (ckpt 900) | 77/80 |
| 4 | 5th (ckpt 900) | 74/80 |
| 5 | 6th (ckpt 700) | 47/80 |
| 6 | 4th (final) | 31/80 |
| 7 | 1st (final) | 0/80 |

2nd-trial jumps straight to #2 overall — ahead of 5th, 6th, 7th, and every trial that came after
it chronologically. It was written off on the strength of a crash, not on the strength of its
output.
