FROM golang:1.26-alpine3.24@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS build

RUN apk add --no-cache git

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

COPY patches/mediamtx-hls-partial-session-close.patch /tmp/mediamtx-hls-partial-session-close.patch
RUN git -C /src/mediamtx apply --check /tmp/mediamtx-hls-partial-session-close.patch \
    && git -C /src/mediamtx apply /tmp/mediamtx-hls-partial-session-close.patch

RUN cd /src/mediamtx \
    && go mod edit -replace github.com/bluenviron/gortmplib=/src/gortmplib \
    && go generate ./... \
    && go test ./internal/servers/hls ./internal/servers/rtmp \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/mediamtx .

FROM bluenviron/mediamtx:1.19.2-ffmpeg@sha256:08c837deb7bac85d509e2a4c2737308e5a34f8f084a46a0d8793cdb0579a6e5d

LABEL org.opencontainers.image.source="https://github.com/bluenviron/mediamtx" \
      org.opencontainers.image.revision="7eb5d30075ae68a36c07c3f1231af04a0e49f804" \
      com.scorecheck.gortmplib.revision="c9c2ddd362aa155e0c8e35b6713f7ebdd731f7aa" \
      com.scorecheck.hls-session-close-race="nil-safe-v1" \
      com.scorecheck.compatibility="avkans-rtmp-adts-aac-v2"

COPY --from=build /out/mediamtx /mediamtx
