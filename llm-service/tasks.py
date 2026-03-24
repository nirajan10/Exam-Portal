"""
Celery tasks for async LLM grading.

The worker loads its own copy of the model and processes one task at a time
(concurrency=1) so the LLM is never overloaded.
"""

import json
import logging
import os
import re
from pathlib import Path

from celery import Celery

logger = logging.getLogger("llm-worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")

celery_app = Celery("llm-grader", broker=REDIS_URL, backend=REDIS_URL)
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    result_expires=3600,
    worker_concurrency=1,
    worker_prefetch_multiplier=1,
)

# ── Model (loaded once per worker process) ──────────────────────────────────

MODEL_REPO = os.getenv("MODEL_REPO", "Qwen/Qwen2.5-3B-Instruct-GGUF")
MODEL_FILE = os.getenv("MODEL_FILE", "qwen2.5-3b-instruct-q4_k_m.gguf")
MODEL_DIR = Path(os.getenv("MODEL_DIR", "/app/models"))
N_CTX = int(os.getenv("N_CTX", "4096"))
N_THREADS = int(os.getenv("N_THREADS", "4"))

_llm = None


def _get_llm():
    global _llm
    if _llm is not None:
        return _llm

    model_path = MODEL_DIR / MODEL_FILE
    if not model_path.exists():
        from huggingface_hub import hf_hub_download
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        hf_hub_download(
            repo_id=MODEL_REPO,
            filename=MODEL_FILE,
            local_dir=str(MODEL_DIR),
            local_dir_use_symlinks=False,
        )

    from llama_cpp import Llama
    logger.info("Worker loading model (n_ctx=%d, n_threads=%d) …", N_CTX, N_THREADS)
    _llm = Llama(
        model_path=str(model_path),
        n_ctx=N_CTX,
        n_threads=N_THREADS,
        verbose=False,
        chat_format="chatml",
    )
    logger.info("Worker model loaded.")
    return _llm


# ── Prompt builders (duplicated from main.py to keep worker self-contained) ─

SYSTEM_PROMPT = """You are a fair and accurate exam grader. You evaluate student answers and return a JSON score.

IMPORTANT RULES:
- Read the question and answer carefully before judging.
- A correct answer MUST receive full or near-full marks.
- A partially correct answer should receive partial marks.
- Only give 0 marks if the answer is completely wrong or empty.
- Be fair — do not penalize correct answers.
- Ignore minor grammatical or spelling errors if the answer is otherwise correct.
- Expect answers according to the question's max points, and grade proportionally. No need to be extremely precise, just a reasonable estimate.

You MUST respond with ONLY a JSON object in this exact format (no markdown, no extra text):
{"score": <number>, "feedback": "<brief feedback>"}"""


def _build_theory_prompt(req: dict) -> str:
    return f"""Grade this theory question.

Question: {req['question_content']}

Maximum Marks: {req['max_points']}

Student's Answer: {req['student_answer']}

Evaluate correctness, completeness, and clarity. Correct the spelling if necessary. A correct answer should get full marks.

Respond with ONLY: {{"score": <0 to {req['max_points']}>, "feedback": "<brief feedback>"}}"""


def _build_code_prompt(req: dict) -> str:
    lang_labels = {"python": "Python 3", "c": "C", "cpp": "C++ 17"}
    lang = lang_labels.get(req.get("language", ""), req.get("language") or "code")

    prompt = f"""Grade this coding question.

Question: {req['question_content']}

Required Programming Language: {lang}

Maximum Marks: {req['max_points']}

Student's Code:
```
{req['student_answer']}
```

"""
    er = req.get("execution_result")
    if er:
        if er.get("timed_out"):
            prompt += "Execution: TIMED OUT\n\n"
        else:
            prompt += f"Execution Exit Code: {er['exit_code']}\n"
            if er.get("stdout"):
                prompt += f"Stdout:\n```\n{er['stdout'][:2000]}\n```\n"
            if er.get("stderr"):
                prompt += f"Stderr:\n```\n{er['stderr'][:1000]}\n```\n"
            prompt += "\n"

    prompt += f"""Grading criteria:
1. The question REQUIRES {lang}. If the student wrote code in a different programming language, give 0 marks regardless of correctness.
2. Does the code solve the problem correctly?
3. Does it compile/run without errors?
4. Is the logic sound (not just hardcoded output)?
5. If code simply prints expected output without computing, give very low marks.
6. A working correct solution should get full marks.
7. If the code is partially correct (e.g., correct logic but minor bugs), award partial marks accordingly.
8. Be lenient on minor issues if the overall approach is correct (cut 0.5 for a small bugs).

Respond with ONLY: {{"score": <0 to {req['max_points']}>, "feedback": "<brief feedback>"}}"""

    return prompt


# ── Parsing ─────────────────────────────────────────────────────────────────

SCORE_RE = re.compile(r'\{\s*"score"\s*:\s*([\d.]+)\s*,\s*"feedback"\s*:\s*"([^"]*)"\s*\}')


def _parse_response(text: str, max_points: int) -> dict:
    cleaned = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()

    try:
        data = json.loads(cleaned)
        score = max(0.0, min(float(data["score"]), float(max_points)))
        score = round(score, 1)
        return {"score": score, "feedback": data.get("feedback", "")}
    except (json.JSONDecodeError, KeyError, ValueError):
        pass

    m = SCORE_RE.search(cleaned)
    if m:
        score = max(0.0, min(float(m.group(1)), float(max_points)))
        score = round(score, 1)
        return {"score": score, "feedback": m.group(2)}

    raise ValueError(f"Could not parse LLM output: {cleaned[:200]}")


# ── Celery task ─────────────────────────────────────────────────────────────

@celery_app.task(bind=True, max_retries=1, default_retry_delay=5)
def grade_answer(self, req: dict) -> dict:
    """Grade a single answer. Returns {"score": float, "feedback": str}."""
    try:
        model = _get_llm()
    except Exception as e:
        raise self.retry(exc=e)

    if req.get("question_type") == "code":
        user_prompt = _build_code_prompt(req)
    else:
        user_prompt = _build_theory_prompt(req)

    logger.info(
        "Grading %s question (max_points=%d, answer_len=%d)",
        req.get("question_type", "unknown"),
        req.get("max_points", 0),
        len(req.get("student_answer", "")),
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]

    response = model.create_chat_completion(
        messages=messages,
        max_tokens=256,
        temperature=0.1,
        response_format={"type": "json_object"},
    )

    text = response["choices"][0]["message"]["content"].strip()
    logger.info("Raw LLM output: %s", text[:300])

    try:
        result = _parse_response(text, req["max_points"])
    except ValueError as e:
        logger.error("Parse failed: %s", e)
        raise self.retry(exc=e)

    logger.info("Graded: score=%.1f feedback=%s", result["score"], result["feedback"][:100])
    return result
