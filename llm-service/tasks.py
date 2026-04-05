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

SYSTEM_PROMPT = """You are a lenient and encouraging exam grader. You evaluate student answers and return a JSON score.

IMPORTANT RULES:
- Be lenient — when in doubt, give the benefit of the doubt to the student.
- Ignore ALL grammar, spelling, and punctuation mistakes. Focus only on the meaning and knowledge shown.
- A correct answer MUST receive full or near-full marks.
- Award partial marks generously for any genuine attempt, even if incomplete or imprecise.
- Never give 0 marks if the student has made a real attempt and shown any relevant understanding.
- Only give 0 marks if the answer is completely blank, entirely off-topic, or shows zero understanding.
- Grade proportionally to max points: a low-mark question only needs key points, not exhaustive detail. A high-mark question expects more depth.
- Small mistakes, minor omissions, and imprecise wording should not significantly reduce marks.

You MUST respond with ONLY a JSON object in this exact format (no markdown, no extra text):
{"score": <number>, "feedback": "<brief feedback>"}"""


def _build_theory_prompt(req: dict) -> str:
    return f"""Grade this theory question leniently.

Question: {req['question_content']}

Maximum Marks: {req['max_points']}

Student's Answer: {req['student_answer']}

Grading instructions:
- Ignore all grammar, spelling, and punctuation errors — focus only on knowledge and meaning.
- Award marks for any correct information shown, even if the answer is incomplete or poorly worded.
- For low-mark questions ({req['max_points']} mark(s)), a brief correct answer is sufficient — do not require exhaustive detail.
- For higher-mark questions, expect more depth but still be lenient on minor gaps.
- Give partial marks generously for any genuine attempt showing relevant understanding.
- Only give 0 if the answer is completely blank or totally irrelevant.

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

    prompt += f"""Grading criteria (be lenient):
1. The question REQUIRES {lang}. If the student wrote code in a different programming language, give 0 marks regardless of correctness.
2. Does the code solve the problem correctly? A working correct solution gets full marks.
3. If the logic is correct but there are minor bugs (off-by-one, small syntax error), deduct at most 0.5–1 mark.
4. If the code is partially correct or shows the right approach with gaps, award generous partial marks.
5. Give marks for any genuine attempt that demonstrates relevant understanding, even if it doesn't run.
6. Hardcoded output with no logic should get very low marks, but still award something for the attempt.
7. Do NOT penalize for code style, naming conventions, or minor inefficiencies.
8. For low-mark questions ({req['max_points']} mark(s)), a simple working solution is fully sufficient.

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
