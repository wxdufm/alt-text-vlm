"""
Manually run the fine-tuned model on one image from data/valid.jsonl.

Usage:
    python scripts/test_single.py --index 0
    python scripts/test_single.py --id d1c85f21-9488-4721-822b-c437610ee895
    python scripts/test_single.py --index 0 --adapter-path adapters/third-trial/checkpoint_700
"""

import argparse
import json

import mlx_vlm

MODEL_PATH = "mlx-community/Qwen3-VL-8B-Instruct-4bit"
ADAPTER_PATH = "adapters/third-trial"
DATASET_PATH = "data/valid.jsonl"


def load_row(index=None, row_id=None):
    with open(DATASET_PATH) as f:
        rows = [json.loads(line) for line in f if line.strip()]
    if row_id is not None:
        return next(r for r in rows if r["id"] == row_id)
    return rows[index]


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--index", type=int)
    group.add_argument("--id", type=str)
    parser.add_argument("--model-path", default=MODEL_PATH)
    parser.add_argument("--adapter-path", default=ADAPTER_PATH)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--repetition-penalty", type=float, default=1.3)
    parser.add_argument("--repetition-context-size", type=int, default=20)
    parser.add_argument("--prefill-step-size", type=int, default=8192)
    args = parser.parse_args()

    row = load_row(index=args.index, row_id=args.id)
    user_prompt = next(m["content"] for m in row["messages"] if m["role"] == "user")
    reference = next(
        (m["content"] for m in row["messages"] if m["role"] == "assistant"), None
    )

    model, processor = mlx_vlm.load(args.model_path, adapter_path=args.adapter_path)

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
        verbose=True,
    )

    print("\n" + "=" * 20 + " IMAGE " + "=" * 20)
    print(row["image"])
    print("\n" + "=" * 20 + " REFERENCE " + "=" * 20)
    print(reference)
    print("\n" + "=" * 20 + " PREDICTION " + "=" * 20)
    print(result.text)


if __name__ == "__main__":
    main()
