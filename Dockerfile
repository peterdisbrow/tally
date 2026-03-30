# Stage 1: Build admin SPA
FROM node:20-alpine AS admin-build
WORKDIR /app/admin
COPY relay-server/admin/package*.json ./
RUN npm ci
COPY relay-server/admin/ .
RUN npm run build

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
