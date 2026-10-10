# 发布到 Sealos

控制台是 [https://bja.sealos.run](https://bja.sealos.run)。应用地址是 [https://ledger-7aie87ej.bja.sealos.run](https://ledger-7aie87ej.bja.sealos.run)。

本机 kubeconfig 上下文是 `7aie87ej@sealos`，命名空间 `ns-7aie87ej`。下面的命令都在这个上下文里执行。

## 线上只跑记账

| 名字 | 作用 | 平时 |
|------|------|------|
| `ledger` | 记账进程。端口 3000，库文件 `/data/ledger.db` | 开着，1 个副本 |

应用镜像放在腾讯云个人版仓库，命名空间 `ledger-qqhzy`，地址：

`ccr.ccs.tencentyun.com/ledger-qqhzy/ledger:<tag>`

这个命名空间是私有的。Sealos 用 Secret `ccr-ledger` 拉取。基础镜像仍用腾讯云公开库 `ccr.ccs.tencentyun.com/library/alpine`。

Sealos 自带 Harbor 推送会返回 500，所以不走 Harbor。集群里曾经有一份临时仓库 `ledger-registry`，切到腾讯云并确认新 Pod 起来之后，可以在控制台删掉它。

## 规格

Sealos 应用管理的最低档：

- 副本保持 1。SQLite 不能多副本同时写
- CPU 上限 `100m`，内存上限 `128Mi`。`Dockerfile` 里的 `NODE_OPTIONS` 把 V8 堆限制在 64MB，改内存规格时一起调
- 磁盘 `1Gi`，挂在 `/data`

登录密钥在 Secret `ledger-env`（`JWT_SECRET`、`ADMIN_TOKEN`）。换 `JWT_SECRET` 会让已有登录全部失效。

## 镜像怎么来的

`Dockerfile` 的基础镜像是腾讯云 `ccr.ccs.tencentyun.com/library/alpine`。这个库没有 Node 镜像，里面的 Alpine 也只有 Node 20.15，而 `better-sqlite3` 13 需要 Node 22，所以镜像里再装一份 musl 版 Node 22。

本机是 Apple Silicon，Sealos 节点是 `linux/amd64`。构建必须带 `--platform linux/amd64`。交叉构建时 esbuild 的安装校验会在 qemu 里段错误，所以 `Dockerfile` 跳过 postinstall，并手动放上 musl 版 `better-sqlite3` 和 `linux-x64` 的 esbuild。

网页要先在本机构建。`Dockerfile` 会检查 `public/index.html`，这个文件在 `.gitignore` 里，不会出现在仓库里。服务端在镜像里编译成 `dist/node.js`，线上用 `node` 直接跑，不再用 `tsx`。

## 首次发布时做过的事

这些对象已经在集群里，重新发布不要再建一套。

1. Secret `ledger-env`：生产环境的 `JWT_SECRET`、`ADMIN_TOKEN`。
2. Certificate `ledger-public`：Secret 名是 `ledger-public-tls`。签发用的是已有 Issuer `network-rdvrsyofxtby`。
3. StatefulSet / Service / Ingress `ledger`：外网 `https://ledger-7aie87ej.bja.sealos.run`。

拉取密钥 `ccr-ledger` 在第一次推到腾讯云时创建，见下面第 2 步。用户名是个人版实例卡片上的账号 ID，密码是访问密码，不是腾讯云登录密码。

健康检查是 `GET /api/health`，正常返回 `{"ok":true,"service":"ledger"}`。

## 改完代码后重新发布

在仓库根目录执行。镜像标签固定为 `latest`，拉取策略是 `Always`，每次新建 Pod 都会向腾讯云核对并拉取该标签的当前内容。

### 1. 构建网页和镜像

```bash
npm run build:web
docker build --platform linux/amd64 -t ledger:sealos .
```

有新增表时，先看 `sql/migrations/`。进程启动会套用 `sql/schema.sql` 里的建表语句，并给旧库补已写在代码里的列。迁移脚本本身不会在启动时自动跑，需要的话先对 `/data/ledger.db` 执行 `npm run db:migrate`，再换镜像。

### 2. 推到腾讯云

第一次推之前，在本机登录一次。用户名是个人版实例上的账号 ID，密码是访问密码：

```bash
docker login ccr.ccs.tencentyun.com
```

然后推送。标签固定用 `latest`：

```bash
docker tag ledger:sealos ccr.ccs.tencentyun.com/ledger-qqhzy/ledger:latest
docker push ccr.ccs.tencentyun.com/ledger-qqhzy/ledger:latest
```

仓库 `ledger` 第一次推送时会自动建出来。

集群里还没有拉取密钥时建一次。已有就跳过：

```bash
kubectl -n ns-7aie87ej create secret docker-registry ccr-ledger \
  --docker-server=ccr.ccs.tencentyun.com \
  --docker-username=<账号ID> \
  --docker-password=<访问密码>
kubectl -n ns-7aie87ej patch statefulset ledger --type json -p '[
  {"op":"replace","path":"/spec/template/spec/imagePullSecrets","value":[{"name":"ccr-ledger"}]}
]'
```

### 3. 让线上重新拉取

镜像名没变，StatefulSet 不会自己滚动。重启后新 Pod 会按 `Always` 拉取 `latest`，`/data` 上的库还在：

```bash
kubectl -n ns-7aie87ej rollout restart statefulset/ledger
kubectl -n ns-7aie87ej rollout status statefulset/ledger
```

### 4. 检查

```bash
curl -sS https://ledger-7aie87ej.bja.sealos.run/api/health
```

健康检查应返回 `{"ok":true,"service":"ledger"}`。首页应是 200。确认新 Pod 已经用腾讯云镜像起来之后，再在控制台删除旧的 `ledger-registry`。

发布失败时看 `kubectl -n ns-7aie87ej logs pod/ledger-0`。退出码 139 是原生模块崩了，先确认镜像是 `linux/amd64`，并且用的是 musl 版 `better-sqlite3`。
