# syntax=docker/dockerfile:1
FROM golang:1.26-bookworm AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY userscripts/embed.go userscripts/chaoxing-questionbank.user.js ./userscripts/
# SQLite uses CGO. Build in the target platform's Debian environment so the
# resulting binary and runtime use the same libc (including ARM64 builds).
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /out/questionbank ./cmd/server

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 questionbank \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin questionbank \
    && mkdir -p /app/config /app/data \
    && chown -R 10001:10001 /app

WORKDIR /app
COPY --from=build /out/questionbank /usr/local/bin/questionbank
USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent --show-error --max-time 4 http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/questionbank"]
CMD ["-config", "/app/config/config.yaml"]
