"""
Local LLM Grading Service for Exam Portal.

Runs a quantized model (Qwen2.5-3B-Instruct) via llama-cpp-python
and exposes a FastAPI endpoint for grading theory and code answers.
"""

import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("llm-service")

# ── Configuration ────────────────────────────────────────────────────────────

MODEL_REPO = os.getenv("MODEL_REPO", "Qwen/Qwen2.5-3B-Instruct-GGUF")
MODEL_FILE = os.getenv("MODEL_FILE", "qwen2.5-3b-instruct-q4_k_m.gguf")
MODEL_DIR = Path(os.getenv("MODEL_DIR", "/app/models"))
N_CTX = int(os.getenv("N_CTX", "4096"))
N_THREADS = int(os.getenv("N_THREADS", "4"))

# ── Global model reference ───────────────────────────────────────────────────

llm = None


def download_model() -> Path:
    """Download the GGUF model file if not already cached."""
    model_path = MODEL_DIR / MODEL_FILE
    if model_path.exists():
        logger.info("Model already cached at %s", model_path)
        return model_path

    logger.info("Downloading %s from %s …", MODEL_FILE, MODEL_REPO)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    from huggingface_hub import hf_hub_download

    path = hf_hub_download(
        repo_id=MODEL_REPO,
        filename=MODEL_FILE,
        local_dir=str(MODEL_DIR),
        local_dir_use_symlinks=False,
    )
    logger.info("Model downloaded to %s", path)
    return Path(path)


def load_model():
    """Load the GGUF model into llama-cpp-python."""
    global llm
    model_path = download_model()

    from llama_cpp import Llama

    logger.info("Loading model (n_ctx=%d, n_threads=%d) …", N_CTX, N_THREADS)
    llm = Llama(
        model_path=str(model_path),
        n_ctx=N_CTX,
        n_threads=N_THREADS,
        verbose=False,
        chat_format="chatml",
    )
    logger.info("Model loaded successfully.")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_model()
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


def build_theory_prompt(req: GradeRequest) -> str:
    return f"""Grade this theory question.

Question: {req.question_content}

Maximum Marks: {req.max_points}

Student's Answer: {req.student_answer}

Evaluate correctness, completeness, and clarity. Correct the spelling if necessary. A correct answer should get full marks.

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

    prompt += f"""Grading criteria:
1. The question REQUIRES {lang}. If the student wrote code in a different programming language, give 0 marks regardless of correctness.
2. Does the code solve the problem correctly?
3. Does it compile/run without errors?
4. Is the logic sound (not just hardcoded output)?
5. If code simply prints expected output without computing, give very low marks.
6. A working correct solution should get full marks.
7. If the code is partially correct (e.g., correct logic but minor bugs), award partial marks accordingly.
8. Be lenient on minor issues if the overall approach is correct (cut 0.5 for a small bugs).

Respond with ONLY: {{"score": <0 to {req.max_points}>, "feedback": "<brief feedback>"}}"""

    return prompt


# ── Parsing ──────────────────────────────────────────────────────────────────

SCORE_RE = re.compile(r'\{\s*"score"\s*:\s*([\d.]+)\s*,\s*"feedback"\s*:\s*"([^"]*)"\s*\}')


def parse_response(text: str, max_points: int) -> GradeResponse:
    """Parse the LLM output into a GradeResponse, with fallback regex."""
    cleaned = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()

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
        raise HTTPException(503, "Model not loaded")
    return {"status": "ok", "model": MODEL_FILE}


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
        # Convert execution_result from Pydantic model to plain dict for JSON serialization.
        if payload.get("execution_result") is not None:
            payload["execution_result"] = dict(payload["execution_result"])
        task = grade_answer.delay(payload)
        task_map[item.id] = task.id
    return {"tasks": task_map, "total": len(task_map)}


class TaskStatusRequest(BaseModel):
    task_ids: list[str]


@app.post("/grade/status")
def grade_status(req: TaskStatusRequest):
    """Check the status of one or more Celery tasks.

    Returns a dict of task_id → {state, result} for each requested task.
    """
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
