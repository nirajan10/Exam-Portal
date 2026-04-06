"""
Local LLM Grading Service for Exam Portal.

Runs a quantized GGUF model (Qwen2.5-7B-Instruct) via llama-cpp-python
and exposes a FastAPI endpoint for grading theory and code answers.
"""

import json
import logging
import os
import re
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("llm-service")

# ── Configuration ────────────────────────────────────────────────────────────

MODEL_REPO = os.getenv("MODEL_REPO", "Qwen/Qwen2.5-7B-Instruct-GGUF")
MODEL_FILE = os.getenv("MODEL_FILE", "qwen2.5-7b-instruct-q3_k_m.gguf")
MODEL_DIR = Path(os.getenv("MODEL_DIR", "/app/models"))
N_CTX = int(os.getenv("N_CTX", "4096"))
N_THREADS = int(os.getenv("N_THREADS", "4"))
N_GPU_LAYERS = int(os.getenv("N_GPU_LAYERS", "-1"))  # -1 = all layers on GPU

# ── Global model reference ───────────────────────────────────────────────────

llm = None
loading_status = "starting"  # starting → downloading → loading → ready / error


def download_model() -> Path:
    """Download the GGUF model file if not already cached."""
    global loading_status
    model_path = MODEL_DIR / MODEL_FILE
    if model_path.exists():
        logger.info("Model already cached at %s", model_path)
        return model_path

    loading_status = "downloading"
    logger.info("Downloading %s from %s …", MODEL_FILE, MODEL_REPO)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    from huggingface_hub import hf_hub_download

    path = hf_hub_download(
        repo_id=MODEL_REPO,
        filename=MODEL_FILE,
        local_dir=str(MODEL_DIR),
    )
    logger.info("Model downloaded to %s", path)
    return Path(path)


def load_model():
    """Load the GGUF model into llama-cpp-python."""
    global llm, loading_status
    try:
        model_path = download_model()

        loading_status = "loading"
        from llama_cpp import Llama

        logger.info("Loading model (n_ctx=%d, n_threads=%d, n_gpu_layers=%d) …", N_CTX, N_THREADS, N_GPU_LAYERS)
        llm = Llama(
            model_path=str(model_path),
            n_ctx=N_CTX,
            n_threads=N_THREADS,
            n_gpu_layers=N_GPU_LAYERS,
            flash_attn=True,
            verbose=False,
            chat_format="chatml",
        )
        loading_status = "ready"
        logger.info("Model loaded successfully.")
    except Exception:
        loading_status = "error"
        logger.exception("Failed to load model")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=load_model, daemon=True).start()
    yield


app = FastAPI(title="Exam Portal LLM Grader", lifespan=lifespan)

# ── Schemas ──────────────────────────────────────────────────────────────────


class ExecutionResult(BaseModel):
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0
    timed_out: bool = False


class GradeRequest(BaseModel):
    question_content: str
    question_type: str  # "theory" or "code"
    max_points: int
    student_answer: str
    language: str = ""
    execution_result: ExecutionResult | None = None


class GradeResponse(BaseModel):
    score: float
    feedback: str


# ── Prompt builders ──────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a lenient and encouraging exam grader. Always lean toward giving MORE marks, not fewer.

GRADING PHILOSOPHY — three tiers:
1. FULL or HIGH marks: The answer is correct or mostly correct. Ignore grammar, spelling, punctuation, and minor missing details — these are NEVER reasons to deduct. If the student shows they understand the concept, even partially or informally, give full or near-full marks. When in doubt, give full marks.
2. MODERATE marks (around half): The answer adds SOME relevant information but is significantly incomplete or only loosely related. Still give at least half marks if the student shows any relevant understanding.
3. LOW or ZERO marks: ONLY when the answer provides NO useful information at all — it merely restates the question in different words, is entirely off-topic, or is blank.

IMPORTANT:
- Pay attention to what the question asks: "how" expects a process/method, "what" expects a definition, "why" expects a reason, "list/name" expects specific items. Check if the student addressed what was asked.
- An answer that just restates the question without adding new information is NOT a valid answer.
- An answer that is correct but brief, informal, or has grammar mistakes IS a valid answer — give full or high marks.
- Grade proportionally to max points: a 1-mark question needs just one key insight; a 5-mark question needs more depth but does NOT require a perfect textbook answer.
- If you are unsure between two scores, pick the one that best reflects what the student demonstrated.

You MUST respond with ONLY a JSON object in this exact format (no markdown, no extra text):
{"score": <number>, "feedback": "<brief feedback>"}"""


def build_theory_prompt(req: GradeRequest) -> str:
    return f"""Grade this theory answer.

Question: {req.question_content}

Maximum Marks: {req.max_points}

Student's Answer: {req.student_answer}

STEP 1 — Determine what the question is asking:
- "How" → expects an explanation of mechanism, process, or method.
- "What" → expects a definition, description, or identification.
- "Why" → expects a reason, justification, or rationale.
- "List/Name/State" → expects specific items or facts.
- "Explain/Describe" → expects a clear explanation with some depth.
Then check: did the student actually answer what was asked?

STEP 2 — Grade using these tiers:
- FULL MARKS ({req.max_points}/{req.max_points}): The answer is correct or mostly correct. Ignore grammar, spelling, and minor gaps. A brief but correct answer is enough for {req.max_points} mark(s). If the student clearly understands the concept, give full marks even if the explanation isn't perfect.
- MODERATE MARKS (around half): The answer adds some relevant information beyond the question but is significantly incomplete. Still give at least half marks for any relevant understanding shown.
- LOW/ZERO MARKS: ONLY when the answer adds NO information beyond restating the question, or is completely off-topic or blank.

Key rule: Compare the answer against the question — if the answer does not add any information that wasn't already in the question itself, give low or zero marks. But if it adds even a little correct information, give at least moderate marks.

Respond with ONLY: {{"score": <0 to {req.max_points}>, "feedback": "<brief feedback>"}}"""


def build_code_prompt(req: GradeRequest) -> str:
    lang_labels = {"python": "Python 3", "c": "C", "cpp": "C++ 17"}
    lang = lang_labels.get(req.language, req.language or "code")

    prompt = f"""Grade this coding question.

Question: {req.question_content}

Required Programming Language: {lang}

Maximum Marks: {req.max_points}

Student's Code:
```
{req.student_answer}
```

"""
    if req.execution_result:
        er = req.execution_result
        if er.timed_out:
            prompt += "Execution: TIMED OUT\n\n"
        else:
            prompt += f"Execution Exit Code: {er.exit_code}\n"
            if er.stdout:
                prompt += f"Stdout:\n```\n{er.stdout[:2000]}\n```\n"
            if er.stderr:
                prompt += f"Stderr:\n```\n{er.stderr[:1000]}\n```\n"
            prompt += "\n"

    prompt += f"""Grading rules:
1. LANGUAGE CHECK: The question REQUIRES {lang}. If the student wrote in a completely different language, give 0 marks.
2. FULL MARKS ({req.max_points}/{req.max_points}): Code is correct or nearly correct. Do not deduct for style, naming, or minor inefficiency. Minor bugs (off-by-one, small typo, missing edge case) — give full marks or deduct at most 0.5.
3. HIGH MARKS: Logic and approach are correct but has a small syntax error or doesn't fully compile — give nearly full marks.
4. MODERATE MARKS: Partially correct code that shows the right approach but has significant gaps.
5. LOW MARKS: Code shows minimal understanding or is mostly hardcoded output with no real logic.
6. ZERO: Completely wrong language, blank, or no relevant code at all.
7. For a {req.max_points}-mark question, a simple working solution is fully sufficient.
8. When unsure whether to deduct, favor the student.

Respond with ONLY: {{"score": <0 to {req.max_points}>, "feedback": "<brief feedback>"}}"""

    return prompt


# ── Parsing ──────────────────────────────────────────────────────────────────

SCORE_RE = re.compile(r'\{\s*"score"\s*:\s*([\d.]+)\s*,\s*"feedback"\s*:\s*"([^"]*)"\s*\}')


def parse_response(text: str, max_points: int) -> GradeResponse:
    """Parse the LLM output into a GradeResponse, with fallback regex.

    Strips <think>...</think> blocks before parsing.
    """
    cleaned = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    cleaned = cleaned.removeprefix("```json").removeprefix("```").removesuffix("```").strip()

    # Try direct JSON parse.
    try:
        data = json.loads(cleaned)
        score = max(0.0, min(float(data["score"]), float(max_points)))
        score = round(score, 1)
        return GradeResponse(score=score, feedback=data.get("feedback", ""))
    except (json.JSONDecodeError, KeyError, ValueError):
        pass

    # Fallback: regex extraction.
    m = SCORE_RE.search(cleaned)
    if m:
        score = max(0.0, min(float(m.group(1)), float(max_points)))
        score = round(score, 1)
        return GradeResponse(score=score, feedback=m.group(2))

    raise ValueError(f"Could not parse LLM output: {cleaned[:200]}")


# ── Endpoints ────────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    if llm is None:
        return {"status": loading_status, "model": MODEL_FILE, "ready": False}
    return {"status": "ready", "model": MODEL_FILE, "ready": True}


@app.post("/grade", response_model=GradeResponse)
def grade(req: GradeRequest):
    if llm is None:
        raise HTTPException(503, "Model not loaded yet")

    if req.question_type == "code":
        user_prompt = build_code_prompt(req)
    else:
        user_prompt = build_theory_prompt(req)

    logger.info(
        "Grading %s question (max_points=%d, answer_len=%d)",
        req.question_type,
        req.max_points,
        len(req.student_answer),
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]

    response = llm.create_chat_completion(
        messages=messages,
        max_tokens=256,
        temperature=0.1,
        response_format={"type": "json_object"},
    )

    text = response["choices"][0]["message"]["content"].strip()

    logger.info("Raw LLM output: %s", text[:300])

    try:
        result = parse_response(text, req.max_points)
    except ValueError as e:
        logger.error("Parse failed: %s", e)
        raise HTTPException(502, f"Failed to parse LLM response: {e}")

    logger.info("Graded: score=%.1f feedback=%s", result.score, result.feedback[:100])
    return result


# ── Async grading via Celery ────────────────────────────────────────────────

from tasks import celery_app as _celery_app, grade_answer  # noqa: E402


class BatchGradeItem(BaseModel):
    """One item in a batch grading request."""
    id: str  # caller-defined key so results can be mapped back
    question_content: str
    question_type: str
    max_points: int
    student_answer: str
    language: str = ""
    execution_result: ExecutionResult | None = None


class BatchGradeRequest(BaseModel):
    items: list[BatchGradeItem]


@app.post("/grade/batch")
def grade_batch(req: BatchGradeRequest):
    """Submit a batch of grading tasks to the Celery queue.

    Returns a mapping of caller id → Celery task id so the caller can poll.
    """
    task_map: dict[str, str] = {}
    for item in req.items:
        payload = item.model_dump()
        if payload.get("execution_result") is not None:
            payload["execution_result"] = dict(payload["execution_result"])
        task = grade_answer.delay(payload)
        task_map[item.id] = task.id
    return {"tasks": task_map, "total": len(task_map)}


class TaskStatusRequest(BaseModel):
    task_ids: list[str]


@app.post("/grade/status")
def grade_status(req: TaskStatusRequest):
    """Check the status of one or more Celery tasks."""
    results: dict[str, dict] = {}
    for tid in req.task_ids:
        ar = _celery_app.AsyncResult(tid)
        entry: dict = {"state": ar.state}
        if ar.state == "SUCCESS":
            entry["result"] = ar.result
        elif ar.state == "FAILURE":
            entry["error"] = str(ar.result)
        results[tid] = entry
    return {"tasks": results}
