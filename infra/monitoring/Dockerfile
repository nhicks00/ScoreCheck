FROM node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

FROM runtime AS agent
ARG CA_CERTIFICATES_VERSION=20260611-r0
ARG FFMPEG_VERSION=8.1.2-r0
USER root
RUN apk add --no-cache "ca-certificates=${CA_CERTIFICATES_VERSION}" "ffmpeg=${FFMPEG_VERSION}" \
  && ffmpeg -hide_banner -version >/dev/null \
  && ffprobe -hide_banner -version >/dev/null \
  && ffmpeg -hide_banner -decoders 2>&1 | grep -Eq '(^|[[:space:]])h264([[:space:]]|$)' \
  && ffmpeg -hide_banner -decoders 2>&1 | grep -Eq '(^|[[:space:]])hevc([[:space:]]|$)' \
  && ffmpeg -hide_banner -decoders 2>&1 | grep -Eq '(^|[[:space:]])aac([[:space:]]|$)' \
  && ffmpeg -hide_banner -demuxers 2>&1 | grep -Eq '(^|[[:space:]])rtsp([[:space:]]|$)'
USER node
CMD ["npm", "run", "start:agent"]

FROM runtime AS service
USER node
CMD ["npm", "run", "start:service"]
