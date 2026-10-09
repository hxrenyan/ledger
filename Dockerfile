# Sealos 应用管理（https://bja.sealos.run）
# 容器端口 3000；持久卷挂到 /data；实例数保持 1（SQLite 单文件）
# 基础镜像用腾讯云 CCR 公开库。library/node 未同步，且库里的 alpine 只有 Node 20.15，
# better-sqlite3 13 需要 Node 22，所以再装一份 musl 版 Node 22。
FROM ccr.ccs.tencentyun.com/library/alpine:latest AS build

WORKDIR /app

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.cloud.tencent.com/g' /etc/apk/repositories \
  && apk add --no-cache curl xz tar libstdc++ \
  && curl -fsSL -o /tmp/node.tar.xz https://unofficial-builds.nodejs.org/download/release/v22.20.0/node-v22.20.0-linux-x64-musl.tar.xz \
  && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
  && rm /tmp/node.tar.xz \
  && node -v \
  && npm -v

COPY package.json package-lock.json* ./
# 跳过 postinstall：本机交叉构建时原生安装脚本会在 qemu 里崩。
# Alpine 用 musl 预编译的 better-sqlite3。
RUN npm config set registry https://mirrors.cloud.tencent.com/npm/ \
  && npm ci --ignore-scripts \
  && mkdir -p node_modules/better-sqlite3/build/Release \
  && cp node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  && chmod +x node_modules/better-sqlite3/build/Release/better_sqlite3.node

COPY . .
RUN npm run build:server \
  && test -f dist/node.js \
  && test -f public/index.html \
  && npm prune --omit=dev

FROM ccr.ccs.tencentyun.com/library/alpine:latest

WORKDIR /app

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.cloud.tencent.com/g' /etc/apk/repositories \
  && apk add --no-cache ca-certificates libstdc++

COPY --from=build /usr/local /usr/local
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/sql /app/sql
COPY --from=build /app/public /app/public
COPY --from=build /app/package.json /app/package.json

ENV NODE_ENV=production
ENV DB_PATH=/data/ledger.db
ENV PORT=3000

EXPOSE 3000
CMD ["node", "dist/node.js"]
