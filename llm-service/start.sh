#!/bin/sh
# Start the Celery worker in the background, then run the FastAPI server.
# Worker concurrency=1 ensures the LLM processes one task at a time.
celery -A tasks worker --loglevel=info --concurrency=1 &
exec uvicorn main:app --host 0.0.0.0 --port 8000
