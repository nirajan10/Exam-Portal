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


def build_theory_prompt(req: GradeRequest) -> str:
    return f"""Grade this theory question leniently.

Question: {req.question_content}

Maximum Marks: {req.max_points}

Student's Answer: {req.student_answer}

Grading instructions:
- Ignore all grammar, spelling, and punctuation errors — focus only on knowledge and meaning.
- Award marks for any correct information shown, even if the answer is incomplete or poorly worded.
- For low-mark questions ({req.max_points} mark(s)), a brief correct answer is sufficient — do not require exhaustive detail.
- For higher-mark questions, expect more depth but still be lenient on minor gaps.
- Give partial marks generously for any genuine attempt showing relevant understanding.
- Only give 0 if the answer is completely blank or totally irrelevant.

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

    prompt += f"""Grading criteria (be lenient):
1. The question REQUIRES {lang}. If the student wrote code in a different programming language, give 0 marks regardless of correctness.
2. Does the code solve the problem correctly? A working correct solution gets full marks.
3. If the logic is correct but there are minor bugs (off-by-one, small syntax error), deduct at most 0.5–1 mark.
4. If the code is partially correct or shows the right approach with gaps, award generous partial marks.
5. Give marks for any genuine attempt that demonstrates relevant understanding, even if it doesn't run.
6. Hardcoded output with no logic should get very low marks, but still award something for the attempt.
7. Do NOT penalize for code style, naming conventions, or minor inefficiencies.
8. For low-mark questions ({req.max_points} mark(s)), a simple working solution is fully sufficient.

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
