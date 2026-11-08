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

在仓库根目录执行。发布镜像按版本打标签，例如 `v1.2.0`；同一标签只对应一次发布，不覆盖已发布版本。修复重发使用新版本号，例如 `v1.2.1`。保留历史版本镜像，并在发版记录中保存版本标签、Git 提交号和镜像摘要，供回滚使用。后端单独发版时使用独立的新版本号，并记录与小程序版本的对应关系。

以下 `v1.2.0` 仅为示例，执行前替换为本次实际版本。现有拉取策略沿用线上配置。

### 1. 构建网页和镜像

```bash
RELEASE_VERSION=v1.2.0
RELEASE_IMAGE="ccr.ccs.tencentyun.com/ledger-qqhzy/ledger:${RELEASE_VERSION}"
npm run build:web
docker build --platform linux/amd64 -t "$RELEASE_IMAGE" .
```

有新增表时，先看 `sql/migrations/`。进程启动会套用 `sql/schema.sql` 里的建表语句，并给旧库补已写在代码里的列。迁移脚本本身不会在启动时自动跑。

线上库已在 2026-10-26 完成联系人归属切换：联系人、日子和日子标签按账本主人账号共用，礼金仍留在原账本。迁移前备份是 `/data/ledger.db.bak-20261026`。进程启动仍不会自动跑 `sql/migrations/`；已经切过的库再执行 `npm run db:migrate` 会跳过这次归属转换。不要把不认识 `contacts.user_id` 的旧后端指到这份库。若要退回迁移前，先停服务，再用该备份覆盖 `/data/ledger.db` 并删掉旁边的 `-wal`、`-shm`，然后启动对应的旧后端。校验方式见 [sql/README.md](../sql/README.md#联系人归属迁移)。

### 2. 推到腾讯云

第一次推之前，在本机登录一次。用户名是个人版实例上的账号 ID，密码是访问密码：

```bash
docker login ccr.ccs.tencentyun.com
```

然后推送本次版本（沿用上一步同一终端中的变量）：

```bash
docker push "$RELEASE_IMAGE"
```

记录推送输出中的镜像摘要，确认仓库保留此前发布的版本，避免清理仍需回滚的镜像。

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

### 3. 更新到指定版本

发布前记录当前容器名、镜像标签以及 Pod 实际镜像摘要。下面读取现有单容器应用的容器名，再更新镜像；镜像字段变化会触发 StatefulSet 更新，无需另行执行滚动重启。`/data` 上的库仍保留。

```bash
kubectl --context 7aie87ej@sealos -n ns-7aie87ej get statefulset ledger -o jsonpath='{.spec.template.spec.containers[*].name}{"\n"}{.spec.template.spec.containers[*].image}{"\n"}'
kubectl --context 7aie87ej@sealos -n ns-7aie87ej get pod ledger-0 -o jsonpath='{.status.containerStatuses[*].imageID}{"\n"}'
LEDGER_CONTAINER=$(kubectl --context 7aie87ej@sealos -n ns-7aie87ej get statefulset ledger -o jsonpath='{.spec.template.spec.containers[0].name}')
kubectl --context 7aie87ej@sealos -n ns-7aie87ej set image statefulset/ledger "${LEDGER_CONTAINER}=${RELEASE_IMAGE}"
kubectl --context 7aie87ej@sealos -n ns-7aie87ej rollout status statefulset/ledger
```

若此前部署使用可覆盖标签，首次切换前先记录实际摘要并确保对应镜像仍在仓库可拉取，作为首次版本发布的回滚基线。

### 4. 检查

```bash
curl -sS https://ledger-7aie87ej.sealosbja.site/api/health
```

健康检查应返回 `{"ok":true,"service":"ledger"}`。首页应是 200。确认新 Pod 已经用腾讯云镜像起来之后，再在控制台删除旧的 `ledger-registry`。

### 5. 回滚到历史版本

先确认目标版本可读取当前数据库，且与已发布的小程序兼容。应用镜像回滚不会自动回滚数据库；本次仅新增的记分表可以保留，恢复整库需单独评估备份后新增数据的损失。

以下 `v1.1.0` 是示例，执行前替换为已验证的目标版本，并与发版记录中的镜像摘要核对：

```bash
ROLLBACK_VERSION=v1.1.0
ROLLBACK_IMAGE="ccr.ccs.tencentyun.com/ledger-qqhzy/ledger:${ROLLBACK_VERSION}"
LEDGER_CONTAINER=$(kubectl --context 7aie87ej@sealos -n ns-7aie87ej get statefulset ledger -o jsonpath='{.spec.template.spec.containers[0].name}')
kubectl --context 7aie87ej@sealos -n ns-7aie87ej set image statefulset/ledger "${LEDGER_CONTAINER}=${ROLLBACK_IMAGE}"
kubectl --context 7aie87ej@sealos -n ns-7aie87ej rollout status statefulset/ledger
kubectl --context 7aie87ej@sealos -n ns-7aie87ej get pod ledger-0 -o jsonpath='{.spec.containers[*].image}{"\n"}{.status.containerStatuses[*].imageID}{"\n"}'
curl --fail --silent --show-error https://ledger-7aie87ej.sealosbja.site/api/health
```

随后验证新旧小程序关键流程、H5 和后台，并在对应发版记录写明回滚时间、原因、目标版本、摘要和验证结果。若首次版本发布需退回此前未版本化的镜像，使用已保存且可拉取的 `仓库地址@sha256:摘要` 作为 `ROLLBACK_IMAGE`。

发布失败时看 `kubectl -n ns-7aie87ej logs pod/ledger-0`。退出码 139 是原生模块崩了，先确认镜像是 `linux/amd64`，并且用的是 musl 版 `better-sqlite3`。
