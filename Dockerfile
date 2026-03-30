FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY relay-server/package*.json ./
RUN npm ci --production
COPY relay-server/ .
RUN mkdir -p data
EXPOSE 3000 1935
CMD ["node", "server.js"]
