# Stage 1: Build admin SPA
FROM node:20-alpine AS admin-build
WORKDIR /app/admin
COPY admin/package*.json ./
RUN npm ci
COPY admin/ .
RUN npm run build

# Stage 2: Production
FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
COPY --from=admin-build /app/public/admin ./public/admin
RUN mkdir -p data
EXPOSE 3000 1935
CMD ["node", "server.js"]
