# BVM production controller — multi-stage build (plan §3.6: runs in Docker on
# the always-on base droplet, holding the DO + egress credentials so they never
# live in Vercel).
#
#   docker build -t bvm-production-controller .
#   docker run --env-file .env -p 127.0.0.1:8080:8080 bvm-production-controller

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
