FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY auth.js integrations.js server.js index.js sercop.html login.html ./
RUN mkdir -p /app/data

ENV NODE_ENV=production \
    NVG_HOST=0.0.0.0 \
    NVG_DB=/app/data/radar.db \
    PORT=3210

EXPOSE 3210

CMD ["node", "server.js"]
