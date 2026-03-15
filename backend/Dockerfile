FROM golang:1.25-alpine AS builder
RUN apk add --no-cache git
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server .

FROM alpine:3.19
RUN apk add --no-cache docker-cli ca-certificates

ARG DOCKER_GID=999
RUN addgroup -g ${DOCKER_GID} dockerhost \
    && adduser -D -G dockerhost appuser

WORKDIR /app
COPY --from=builder /app/server .
RUN mkdir -p /app/uploads/profile_pics \
    && chown appuser:dockerhost /app/server \
    && chown -R appuser:dockerhost /app/uploads

USER appuser
EXPOSE 8080
CMD ["./server"]
