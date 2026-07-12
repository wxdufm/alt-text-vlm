"""
Train a LoRA adapter with a real validation dataset wired in.

mlx_vlm.lora's train() function fully supports periodic validation-loss
evaluation (it calls evaluate() on val_dataset every --steps-per-eval steps),
but the mlx_vlm.lora CLI script hardcodes val_dataset=None, so that never
gets used. This script calls the same underlying library functions but
actually passes a validation dataset, so you get a real train-vs-val loss
curve printed during training.

Usage:
    python scripts/train_lora_with_val.py \
        --model-path mlx-community/Qwen3-VL-8B-Instruct-4bit \
        --train-dataset data/train/train.jsonl \
        --val-dataset data/valid.jsonl \
        --output-path adapters/ \
        --batch-size 4 \
        --lora-rank 16 \
        --train-on-completions \
        --epochs 8
"""

import argparse
import logging

import mlx.optimizers as optim
from datasets import load_dataset

from mlx_vlm.lora import setup_model_for_training, transform_dataset_to_messages
from mlx_vlm.trainer.datasets import VisionDataset
from mlx_vlm.trainer.sft_trainer import TrainingArgs, train
from mlx_vlm.trainer.utils import Colors, not_supported_for_training, print_trainable_parameters
from mlx_vlm.utils import load

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("huggingface_hub").setLevel(logging.WARNING)


def load_jsonl_dataset(path):
    return load_dataset("json", data_files=path, split="train")


def main(args):
    args.output_path = (
        args.output_path
        if args.output_path.endswith(".safetensors")
        else args.output_path + "/adapters.safetensors"
    )

    logger.info(f"{Colors.HEADER}Loading model from {args.model_path}{Colors.ENDC}")
    model, processor = load(args.model_path, processor_config={"trust_remote_code": True})

    model_type = getattr(getattr(model, "config", None), "model_type", None)
    if model_type in not_supported_for_training:
        raise ValueError(f"Model type {model_type} not supported for training")

    config = model.config.__dict__

    logger.info(f"{Colors.HEADER}Loading train dataset from {args.train_dataset}{Colors.ENDC}")
    train_raw = load_jsonl_dataset(args.train_dataset)
    train_raw = transform_dataset_to_messages(train_raw, model_type)

    val_raw = None
    if args.val_dataset:
        logger.info(f"{Colors.HEADER}Loading val dataset from {args.val_dataset}{Colors.ENDC}")
        val_raw = load_jsonl_dataset(args.val_dataset)
        val_raw = transform_dataset_to_messages(val_raw, model_type)

    if args.epochs is not None:
        iters = (len(train_raw) // args.batch_size) * args.epochs
    else:
        iters = args.iters

    train_dataset = VisionDataset(
        train_raw,
        config,
        processor,
        image_resize_shape=args.image_resize_shape,
        train_on_completions=args.train_on_completions,
    )
    val_dataset = (
        VisionDataset(
            val_raw,
            config,
            processor,
            image_resize_shape=args.image_resize_shape,
            train_on_completions=args.train_on_completions,
        )
        if val_raw is not None
        else None
    )

    model = setup_model_for_training(model, args, args.adapter_path)
    print_trainable_parameters(model)

    logger.info(f"{Colors.HEADER}Setting up optimizer{Colors.ENDC}")
    optimizer = optim.Adam(learning_rate=args.learning_rate)

    training_args = TrainingArgs(
        batch_size=args.batch_size,
        iters=iters,
        steps_per_report=args.steps_per_report,
        steps_per_eval=args.steps_per_eval,
        steps_per_save=args.steps_per_save,
        val_batches=args.val_batches,
        max_seq_length=args.max_seq_length,
        adapter_file=args.output_path,
        grad_checkpoint=args.grad_checkpoint,
        learning_rate=args.learning_rate,
        grad_clip=args.grad_clip,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        full_finetune=args.full_finetune,
    )

    logger.info(f"{Colors.HEADER}Training model (iters={iters}){Colors.ENDC}")
    train(
        model=model,
        optimizer=optimizer,
        train_dataset=train_dataset,
        val_dataset=val_dataset,
        args=training_args,
        train_on_completions=args.train_on_completions,
        assistant_id=args.assistant_id,
    )

    logger.info(f"{Colors.HEADER}Training completed! Model saved to {args.output_path}{Colors.ENDC}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train Vision-Language Model with validation")

    parser.add_argument("--model-path", type=str, required=True)
    parser.add_argument("--full-finetune", action="store_true")
    parser.add_argument("--train-vision", action="store_true")

    parser.add_argument("--train-dataset", type=str, required=True)
    parser.add_argument("--val-dataset", type=str, default=None)
    parser.add_argument("--image-resize-shape", type=int, nargs=2, default=None)

    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--iters", type=int, default=1000)
    parser.add_argument("--epochs", type=int, default=None)
    parser.add_argument("--steps-per-report", type=int, default=10)
    parser.add_argument("--steps-per-eval", type=int, default=50)
    parser.add_argument("--steps-per-save", type=int, default=50)
    parser.add_argument("--val-batches", type=int, default=4)
    parser.add_argument("--max-seq-length", type=int, default=768)
    parser.add_argument("--grad-checkpoint", action="store_true")
    parser.add_argument("--grad-clip", type=float, default=None)
    parser.add_argument("--train-on-completions", action="store_true")
    parser.add_argument("--gradient-accumulation-steps", type=int, default=1)
    parser.add_argument("--assistant-id", type=int, default=77091)

    parser.add_argument("--lora-alpha", type=float, default=16)
    parser.add_argument("--lora-rank", type=int, default=8)
    parser.add_argument("--lora-dropout", type=float, default=0.0)

    parser.add_argument("--output-path", type=str, default="adapters.safetensors")
    parser.add_argument("--adapter-path", type=str, default=None)

    args = parser.parse_args()
    main(args)
