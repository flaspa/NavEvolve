"""Liquid AI LFM2.5-VL-3B perception, directly through Hugging Face Transformers.

Official model: https://huggingface.co/LiquidAI/LFM2.5-VL-3B

Loaded ONCE, kept resident on the GPU in bfloat16, and run under
torch.inference_mode(). Follows the model card's Transformers snippet
(transformers >= 5): AutoModelForImageTextToText + AutoProcessor +
processor.apply_chat_template(..., tokenize=True, return_dict=True).

This module provides PERCEPTION only: what is visible from Seekr's eye.
Reasoning and navigation decisions belong to the Seekr Brain, later.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field

from PIL import Image

MODEL_ID = os.environ.get("LIQUID_MODEL_ID", "LiquidAI/LFM2.5-VL-3B")
MAX_NEW_TOKENS = int(os.environ.get("LIQUID_MAX_NEW_TOKENS", "160"))

SYSTEM_PROMPT = (
    "You are Seekr's visual perception system. "
    "Describe only what is visible from this egocentric view. "
    "Be concise and spatially useful. "
    "Identify major objects, openings, obstacles, and useful spatial relationships "
    "(left, right, ahead, near, far). "
    "Do not invent objects that are not visible. "
    "Answer in at most four short sentences."
)


@dataclass
class LiquidPerception:
    model_id: str = MODEL_ID
    status: str = "loading"  # loading | ready | failed
    error: str | None = None
    device: str | None = None
    load_seconds: float | None = None
    _model: object = field(default=None, repr=False)
    _processor: object = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # ------------------------------------------------------------------ load
    def load(self) -> None:
        """Load the model once. Safe to call from a background thread."""
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor

        started = time.perf_counter()
        try:
            device = "cuda" if torch.cuda.is_available() else "cpu"
            dtype = torch.bfloat16 if device == "cuda" else torch.float32

            model = AutoModelForImageTextToText.from_pretrained(self.model_id, dtype=dtype)
            model.to(device)
            model.eval()
            processor = AutoProcessor.from_pretrained(self.model_id)

            self._model = model
            self._processor = processor
            self.device = str(model.device)
            self.load_seconds = round(time.perf_counter() - started, 1)
            self.status = "ready"
            print(f"[liquid] {self.model_id} ready on {self.device} in {self.load_seconds}s")
        except Exception as exc:  # noqa: BLE001 — reported through /health
            self.status = "failed"
            self.error = f"{type(exc).__name__}: {exc}"
            print(f"[liquid] model load FAILED: {self.error}")

    def load_in_background(self) -> threading.Thread:
        thread = threading.Thread(target=self.load, name="liquid-load", daemon=True)
        thread.start()
        return thread

    # -------------------------------------------------------------- perceive
    def perceive(self, image: Image.Image, task: str | None = None) -> dict:
        """One egocentric frame → concise visual description."""
        prompt = SYSTEM_PROMPT
        if task and task.strip():
            prompt += (
                f' The current task is: "{task.strip()}". '
                "If evidence relevant to this task is visible, say what and where it is; "
                "otherwise say that it is not visible. Do not decide any movement."
            )
        raw = self.generate(image, prompt, max_new_tokens=MAX_NEW_TOKENS)
        return {"model": self.model_id, "description": raw["text"], "latency_ms": raw["latency_ms"]}

    def generate(self, image: Image.Image, prompt: str, max_new_tokens: int = MAX_NEW_TOKENS) -> dict:
        """One image + one prompt → raw text (the single inference path)."""
        import torch

        if self.status != "ready":
            raise RuntimeError(f"model not ready (status={self.status})")

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image.convert("RGB")},
                    {"type": "text", "text": prompt},
                ],
            }
        ]

        started = time.perf_counter()
        # One request at a time: a single resident model on one GPU.
        with self._lock:
            inputs = self._processor.apply_chat_template(
                messages,
                add_generation_prompt=True,
                tokenize=True,
                return_dict=True,
                return_tensors="pt",
            ).to(self._model.device)

            with torch.inference_mode():
                output_ids = self._model.generate(
                    **inputs,
                    do_sample=False,
                    repetition_penalty=1.05,
                    max_new_tokens=max_new_tokens,
                )

            generated = output_ids[:, inputs["input_ids"].shape[1] :]
            text = self._processor.batch_decode(generated, skip_special_tokens=True)[0].strip()

        latency_ms = round((time.perf_counter() - started) * 1000)
        return {"text": text, "latency_ms": latency_ms}
