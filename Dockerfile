# Stage 1: Build admin SPA
FROM node:20-alpine AS admin-build
WORKDIR /app/admin
COPY relay-server/admin/package*.json ./
RUN npm ci
COPY relay-server/admin/ .
# Browser Sentry: prefer VITE_SENTRY_DSN; fall back to Railway SENTRY_DSN at image build.
ARG VITE_SENTRY_DSN=
ARG SENTRY_DSN=
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV SENTRY_DSN=$SENTRY_DSN
RUN if [ -z "$VITE_SENTRY_DSN" ] && [ -n "$SENTRY_DSN" ]; then export VITE_SENTRY_DSN="$SENTRY_DSN"; fi; npm run build

# Stage 2: Production
FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY relay-server/package*.json ./
RUN npm ci --production
COPY relay-server/ .
COPY --from=admin-build /app/public/admin ./public/admin
RUN mkdir -p data
EXPOSE 3000 1935
CMD ["node", "server.js"]
