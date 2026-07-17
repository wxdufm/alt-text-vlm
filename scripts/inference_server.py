"""
Persistent inference server for the alt-text generation playground.

Loading the base VLM from disk takes several seconds on its own, so this
process keeps a small LRU cache of (base model + LoRA adapter) combos resident
in memory. Repeated generations against the same trial/checkpoint skip the
reload; switching to a different adapter pays the load cost again (LoRA rank
differs across trials, so weights can't be hot-swapped on a shared model).

Usage:
    python scripts/inference_server.py [--port 8765] [--cache-size 2]
"""

import argparse
import json
import re
from collections import OrderedDict
from pathlib import Path
from typing import Optional

import mlx_vlm
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_PATH = "mlx-community/Qwen3-VL-8B-Instruct-4bit"

# Matches the validated-good defaults from scripts/04_generate_alt_text.py
# (repetition_penalty=1.3 caused degenerate output; fixed to 1.0 on 2026-07-15).
DEFAULT_MAX_TOKENS = 256
DEFAULT_REPETITION_PENALTY = 1.0
DEFAULT_REPETITION_CONTEXT_SIZE = 20
DEFAULT_PREFILL_STEP_SIZE = 8192

TAG_PATTERNS = {
    "description": re.compile(r"<description>(.*?)</description>", re.DOTALL),
    "confidence_score": re.compile(
        r"<confidence-score>(.*?)</confidence-score>", re.DOTALL
    ),
    "confidence_reasoning": re.compile(
        r"<confidence-reasoning>(.*?)</confidence-reasoning>", re.DOTALL
    ),
    "review_triggers": re.compile(
        r"<review-triggers>(.*?)</review-triggers>", re.DOTALL
    ),
}


# Each tag is extracted independently (rather than matching the whole structure at once,
# like scripts/04_generate_alt_text.py's well-formedness check does) because trial formats
# differ — 5th/6th trials drop confidence-reasoning entirely, and any trial can occasionally
# emit a malformed/incomplete tag. Missing tags just come back as None instead of failing
# the whole request.
def _is_url(value):
    return isinstance(value, str) and value.startswith(("http://", "https://"))


def parse_output(text):
    result = {}
    for key, pattern in TAG_PATTERNS.items():
        match = pattern.search(text or "")
        if not match:
            result[key] = None
            continue
        value = match.group(1).strip()
        if key == "review_triggers":
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                pass
        elif key == "confidence_score":
            try:
                value = int(value)
            except ValueError:
                pass
        result[key] = value
    return result


class ModelCache:
    """LRU cache of (model, processor) keyed by adapter path.

    mlx_vlm.load() rebuilds the LoRA-wrapped model structure from scratch for a given
    adapter, so there's no cheaper way to "swap" adapters on an already-loaded model —
    caching whole (base + adapter) combos and evicting the least-recently-used one is the
    best available tradeoff between load latency and memory usage.
    """

    def __init__(self, max_size):
        self.max_size = max_size
        self._entries = OrderedDict()  # adapter_path ("" for none) -> (model, processor)

    def get(self, adapter_path):
        key = adapter_path or ""
        if key in self._entries:
            self._entries.move_to_end(key)
            return self._entries[key]

        model, processor = mlx_vlm.load(
            MODEL_PATH, adapter_path=adapter_path or None
        )
        self._entries[key] = (model, processor)
        self._entries.move_to_end(key)
        while len(self._entries) > self.max_size:
            self._entries.popitem(last=False)
        return self._entries[key]

    def keys(self):
        return [k or "(base, no adapter)" for k in self._entries.keys()]


class GenerateRequest(BaseModel):
    # A local filesystem path in the common case, but may also be an http(s) URL — used
    # for "never reviewed" releases whose cover only exists at their database cover_url,
    # not in data/covers. mlx_vlm.load_image() handles both transparently.
    image_path: str
    artist: str
    title: str
    adapter_path: Optional[str] = None
    max_tokens: int = DEFAULT_MAX_TOKENS
    repetition_penalty: float = DEFAULT_REPETITION_PENALTY
    repetition_context_size: int = DEFAULT_REPETITION_CONTEXT_SIZE


def build_app(cache_size):
    app = FastAPI()
    cache = ModelCache(cache_size)

    @app.get("/health")
    def health():
        return {"status": "ok", "cached": cache.keys()}

    # Called by alt_text_server.js per "Generate Alt Text" click. Paths are resolved to
    # absolute paths by the caller, so no cwd assumptions are made here.
    @app.post("/generate")
    def generate(req: GenerateRequest):
        if _is_url(req.image_path):
            image_arg = req.image_path
        else:
            image_path = Path(req.image_path)
            if not image_path.exists():
                raise HTTPException(
                    status_code=404, detail=f"Image not found: {req.image_path}"
                )
            image_arg = str(image_path)

        if req.adapter_path and not Path(req.adapter_path).exists():
            raise HTTPException(
                status_code=404, detail=f"Adapter not found: {req.adapter_path}"
            )

        model, processor = cache.get(req.adapter_path)

        user_prompt = (
            "Generate accessibility alt text for this album cover.\n"
            f"Artist: {req.artist}\nAlbum title: {req.title}"
        )

        templated_prompt = mlx_vlm.apply_chat_template(
            processor, model.config, user_prompt, num_images=1
        )

        try:
            result = mlx_vlm.generate(
                model,
                processor,
                prompt=templated_prompt,
                image=image_arg,
                max_tokens=req.max_tokens,
                resize_shape=(448, 448),
                repetition_penalty=req.repetition_penalty,
                repetition_context_size=req.repetition_context_size,
                # mlx_vlm's default prefill_step_size (2048) breaks chunked prefill
                # for image prompts once the prompt needs >1 chunk.
                prefill_step_size=DEFAULT_PREFILL_STEP_SIZE,
                verbose=False,
            )
        except ValueError as e:
            # load_image() raises ValueError for unreachable/invalid image sources —
            # most commonly a dead cover_url for a never-reviewed release.
            raise HTTPException(
                status_code=502, detail=f"Failed to load image {req.image_path}: {e}"
            )

        parsed = parse_output(result.text)
        parsed["raw_text"] = result.text
        parsed["prompt"] = user_prompt
        return parsed

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--cache-size",
        type=int,
        default=2,
        help="Max number of (base model + adapter) combos to keep resident in memory",
    )
    args = parser.parse_args()

    import uvicorn

    app = build_app(args.cache_size)
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
