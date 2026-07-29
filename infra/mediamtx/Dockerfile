FROM golang:1.26-alpine3.24@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS build

RUN apk add --no-cache git

RUN git clone https://github.com/bluenviron/gohlslib.git /src/gohlslib \
    && git -C /src/gohlslib checkout --detach 7f399d73c6877dcf98099e90c177a83f0dfc2497 \
    && test "$(git -C /src/gohlslib rev-parse HEAD)" = "7f399d73c6877dcf98099e90c177a83f0dfc2497"

COPY patches/gohlslib-h264-discontinuity-recovery.patch /tmp/gohlslib-h264-discontinuity-recovery.patch
RUN git -C /src/gohlslib apply --check /tmp/gohlslib-h264-discontinuity-recovery.patch \
    && git -C /src/gohlslib apply /tmp/gohlslib-h264-discontinuity-recovery.patch \
    && cd /src/gohlslib \
    && go test ./...

RUN git clone https://github.com/bluenviron/gortmplib.git /src/gortmplib \
    && git -C /src/gortmplib checkout --detach c9c2ddd362aa155e0c8e35b6713f7ebdd731f7aa \
    && test "$(git -C /src/gortmplib rev-parse HEAD)" = "c9c2ddd362aa155e0c8e35b6713f7ebdd731f7aa"

COPY patches/gortmplib-avkans-adts-aac.patch /tmp/gortmplib-avkans-adts-aac.patch
RUN git -C /src/gortmplib apply --check /tmp/gortmplib-avkans-adts-aac.patch \
    && git -C /src/gortmplib apply /tmp/gortmplib-avkans-adts-aac.patch \
    && cd /src/gortmplib \
    && go test ./...

RUN git clone https://github.com/bluenviron/mediamtx.git /src/mediamtx \
    && git -C /src/mediamtx checkout --detach 7eb5d30075ae68a36c07c3f1231af04a0e49f804 \
    && test "$(git -C /src/mediamtx rev-parse HEAD)" = "7eb5d30075ae68a36c07c3f1231af04a0e49f804"

COPY patches/mediamtx-srt-receiver-latency.patch /tmp/mediamtx-srt-receiver-latency.patch
RUN git -C /src/mediamtx apply --check /tmp/mediamtx-srt-receiver-latency.patch \
    && git -C /src/mediamtx apply /tmp/mediamtx-srt-receiver-latency.patch

RUN cd /src/mediamtx \
    && go mod edit -replace github.com/bluenviron/gohlslib/v2=/src/gohlslib \
    && go mod edit -replace github.com/bluenviron/gortmplib=/src/gortmplib \
    && go generate ./... \
    && go test ./internal/servers/rtmp ./internal/servers/srt \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/mediamtx .

FROM bluenviron/mediamtx:1.19.2-ffmpeg@sha256:08c837deb7bac85d509e2a4c2737308e5a34f8f084a46a0d8793cdb0579a6e5d

LABEL org.opencontainers.image.source="https://github.com/bluenviron/mediamtx" \
      org.opencontainers.image.revision="7eb5d30075ae68a36c07c3f1231af04a0e49f804" \
      com.scorecheck.gohlslib.revision="7f399d73c6877dcf98099e90c177a83f0dfc2497" \
      com.scorecheck.gortmplib.revision="c9c2ddd362aa155e0c8e35b6713f7ebdd731f7aa" \
      com.scorecheck.compatibility="avkans-adts-aac-h264-gop-recovery-srt8s-v3"

COPY --from=build /out/mediamtx /mediamtx
