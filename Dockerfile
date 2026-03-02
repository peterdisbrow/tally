FROM node:20-alpine
WORKDIR /app
COPY relay-server/package*.json ./
RUN npm ci --production
COPY relay-server/ .
RUN mkdir -p data
EXPOSE 3000
CMD ["node", "server.js"]
