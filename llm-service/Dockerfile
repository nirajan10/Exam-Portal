FROM python:3.11-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /usr/local/lib/python3.11 /usr/local/lib/python3.11
COPY --from=builder /usr/local/bin /usr/local/bin
COPY . .

VOLUME /app/models
EXPOSE 8000
RUN chmod +x start.sh
CMD ["./start.sh"]
