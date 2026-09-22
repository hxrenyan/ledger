FROM docker.m.daocloud.io/library/node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .
RUN npm run build:web

ENV NODE_ENV=production
ENV DB_PATH=/data/ledger.db
ENV PORT=3000

EXPOSE 3000
CMD ["npx", "tsx", "src/node.ts"]
