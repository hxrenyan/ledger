# Sealos 应用管理（https://bja.sealos.run）
# 容器端口 3000；持久卷挂到 /data；实例数保持 1（SQLite 单文件）
FROM docker.m.daocloud.io/library/node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build:web

ENV NODE_ENV=production
ENV DB_PATH=/data/ledger.db
ENV PORT=3000

EXPOSE 3000
CMD ["npx", "tsx", "src/node.ts"]
