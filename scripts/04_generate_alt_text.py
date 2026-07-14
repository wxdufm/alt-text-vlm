"""
Run the fine-tuned model over data/valid.jsonl, score predictions against
the human-written reference alt text, and write everything to a jsonl file
for manual review.

Usage:
    python scripts/04_generate_alt_text.py
    python scripts/04_generate_alt_text.py --limit 10 --output eval_results/smoke.jsonl
    python scripts/04_generate_alt_text.py --adapter-path adapters/third-trial/checkpoint_700 --output eval_results/checkpoint_700.jsonl
"""

import argparse
import json
import re
from difflib import SequenceMatcher
from pathlib import Path

import mlx_vlm

MODEL_PATH = "mlx-community/Qwen3-VL-8B-Instruct-4bit"
ADAPTER_PATH = "adapters/third-trial"
DATASET_PATH = "data/valid.jsonl"
MAX_DESCRIPTION_CHARS = 130

TAG_RE = re.compile(r"<description>(.*?)</description>", re.DOTALL)

# Full expected structure, in order: description, confidence-score,
# review-triggers, then an optional triggers-addition. confidence-reasoning
# was dropped from the trained format (5th-trial onward) after it turned out
# to dominate the completion length and crowd out the other fields.
STRUCTURE_RE = re.compile(
    r"<description>(.*?)</description>\s*"
    r"<confidence-score>(.*?)</confidence-score>\s*"
    r"<review-triggers>(.*?)</review-triggers>"
    r"(?:\s*<triggers-addition>.*?</triggers-addition>)?\s*",
    re.DOTALL,
)


def load_rows(dataset_path, limit=None):
    with open(dataset_path) as f:
        rows = [json.loads(line) for line in f if line.strip()]
    return rows[:limit] if limit else rows


def extract_description(text):
    match = TAG_RE.search(text or "")
    return match.group(1).strip() if match else None


def is_well_formed(text):
    if not text:
        return False
    match = STRUCTURE_RE.fullmatch(text.strip())
    if not match:
        return False
    description, confidence_score, review_triggers = match.groups()

    if not description.strip():
        return False
    if confidence_score.strip() not in ("0", "1"):
        return False
    try:
        triggers = json.loads(review_triggers.strip())
    except json.JSONDecodeError:
        return False
    return isinstance(triggers, list)


def similarity(a, b):
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def score_row(prediction_text, reference_text):
    pred_desc = extract_description(prediction_text)
    ref_desc = extract_description(reference_text)

    return {
        "prediction_description": pred_desc,
        "reference_description": ref_desc,
        "description_tag_exists": pred_desc is not None,
        "well_formed": is_well_formed(prediction_text),
        "within_char_limit": (
            len(pred_desc) <= MAX_DESCRIPTION_CHARS if pred_desc else False
        ),
        "starts_with_album_cover": (
            pred_desc.lower().startswith("album cover") if pred_desc else False
        ),
        "similarity": similarity(pred_desc, ref_desc),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", default=MODEL_PATH)
    parser.add_argument("--adapter-path", default=ADAPTER_PATH)
    parser.add_argument("--dataset", default=DATASET_PATH)
    parser.add_argument("--output", default="eval_results/valid_predictions.jsonl")
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--repetition-penalty", type=float, default=1.3)
    parser.add_argument("--repetition-context-size", type=int, default=20)
    parser.add_argument("--prefill-step-size", type=int, default=8192)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    rows = load_rows(args.dataset, limit=args.limit)
    print(f"Loaded {len(rows)} rows from {args.dataset}")

    model, processor = mlx_vlm.load(args.model_path, adapter_path=args.adapter_path)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    results = []
    with open(output_path, "w") as out:
        for i, row in enumerate(rows):
            user_prompt = next(
                m["content"] for m in row["messages"] if m["role"] == "user"
            )
            reference = next(
                (m["content"] for m in row["messages"] if m["role"] == "assistant"),
                None,
            )

            templated_prompt = mlx_vlm.apply_chat_template(
                processor, model.config, user_prompt, num_images=1
            )

            result = mlx_vlm.generate(
                model,
                processor,
                prompt=templated_prompt,
                image=row["image"],
                max_tokens=args.max_tokens,
                resize_shape=(448, 448),
                repetition_penalty=args.repetition_penalty,
                repetition_context_size=args.repetition_context_size,
                # mlx_vlm's default prefill_step_size (2048) breaks chunked prefill for
                # image prompts once the prompt needs >1 chunk; keep it above prompt length.
                prefill_step_size=args.prefill_step_size,
                verbose=False,
            )

            scores = score_row(result.text, reference)
            record = {
                "id": row.get("id"),
                "image": row["image"],
                "reference_raw": reference,
                "prediction_raw": result.text,
                **scores,
            }
            results.append(record)
            out.write(json.dumps(record) + "\n")
            out.flush()

            print(
                f"[{i + 1}/{len(rows)}] {row.get('id')} "
                f"description_tag_exists={scores['description_tag_exists']} "
                f"well_formed={scores['well_formed']} "
                f"within_limit={scores['within_char_limit']} "
                f"similarity={scores['similarity']:.2f}"
            )

    n = len(results)
    if n:
        description_tag_exists = sum(r["description_tag_exists"] for r in results)
        well_formed = sum(r["well_formed"] for r in results)
        within_limit = sum(r["within_char_limit"] for r in results)
        starts_bad = sum(r["starts_with_album_cover"] for r in results)
        similarity_scores = [
            r["similarity"] for r in results if r["description_tag_exists"]
        ]
        avg_similarity = (
            sum(similarity_scores) / len(similarity_scores)
            if similarity_scores
            else 0.0
        )

        print("\n" + "=" * 40)
        print(f"Rows scored:              {n}")
        print(f"<description> tag present: {description_tag_exists}/{n}")
        print(f"Well-formed (full structure): {well_formed}/{n}")
        print(f"Within {MAX_DESCRIPTION_CHARS} char limit:     {within_limit}/{n}")
        print(f"Starts with 'album cover': {starts_bad}/{n}")
        print(
            f"Avg text similarity (of {len(similarity_scores)} with a description): "
            f"{avg_similarity:.3f}"
        )
        print(f"\nFull results: {output_path}")


if __name__ == "__main__":
    main()
