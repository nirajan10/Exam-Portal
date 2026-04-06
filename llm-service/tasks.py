"""
Celery tasks for async LLM grading.

The worker delegates to the FastAPI /grade endpoint rather than loading its
own model copy — this avoids OOM on a single GPU where only one 9B model fits.
"""

import logging
import os

import requests
from celery import Celery

logger = logging.getLogger("llm-worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
GRADE_URL = os.getenv("GRADE_URL", "http://localhost:8000/grade")

celery_app = Celery("llm-grader", broker=REDIS_URL, backend=REDIS_URL)
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    result_expires=3600,
    worker_concurrency=1,
    worker_prefetch_multiplier=1,
)


@celery_app.task(bind=True, max_retries=3, default_retry_delay=10)
def grade_answer(self, req: dict) -> dict:
    """Grade a single answer by calling the FastAPI /grade endpoint."""
    logger.info(
        "Grading %s question (max_points=%d)",
        req.get("question_type", "unknown"),
        req.get("max_points", 0),
    )
    try:
        resp = requests.post(GRADE_URL, json=req, timeout=120)
        resp.raise_for_status()
        result = resp.json()
        logger.info("Graded: score=%.1f", result.get("score", 0))
        return result
    except Exception as e:
        logger.error("Grading request failed: %s", e)
        raise self.retry(exc=e)
