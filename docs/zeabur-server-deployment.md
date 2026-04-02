# All API Hub 云端版部署 Runbook

适用场景：

- 已有 Zeabur PostgreSQL 服务
- 准备部署当前仓库中的 `packages/server`
- 希望使用 PostgreSQL 保存结构化数据，Volume 保存 Playwright profile 与 diagnostics
- 希望保留 Telegram 云端入口，但把部分站点的浏览器签到交给本地真实浏览器 worker

当前代码已经固定的运行约束：

- `packages/server` 启动时优先读取 `DATABASE_URL`，未提供时回退到 `POSTGRES_CONNECTION_STRING`
- `SITE_LOGIN_PROFILES_JSON` 可以留空或填 `{}`；一旦提供非空值，就必须是“以 hostname 为 key 的 JSON 对象”
- 单个站点 profile 至少要有 `loginButtonSelectors`
- Playwright 共享 SSO profile 固定落到 `/data/all-api-hub/profiles/cloud/linuxdo-github`
- diagnostics 固定落到 `/data/all-api-hub/diagnostics`
- Telegram 仅允许 `TG_ADMIN_CHAT_ID` 对应的管理员私聊
- 管理员内部 HTTP 接口继续使用 `Authorization: Bearer <INTERNAL_ADMIN_TOKEN>`
- 本地 worker 的领取、心跳、进度、完成回传接口改用 `Authorization: Bearer <LOCAL_WORKER_TOKEN>`

## 1. 部署拓扑

Zeabur 侧建议保留以下服务：

- 一个 PostgreSQL 服务
- 一个 `All API Hub server` 服务
- 一个挂载到 `server:/data` 的 Volume

当前仓库根目录 `Dockerfile` 只会构建 `core + server`，不会构建 Electron 桌面版。

## 2. 部署前准备

在进入 Zeabur 配置前，先准备好以下信息：

- Telegram Bot Token
- 管理员 Telegram `chat_id`
- `TG_WEBHOOK_SECRET`
- `INTERNAL_ADMIN_TOKEN`
- GitHub 用户名
- GitHub 密码
- GitHub TOTP setup key
- 私有仓库只读 PAT
- 导入账号 JSON 的仓库坐标：`owner/repo/path/ref`
- 目标站点的登录按钮选择器

如果当前目标只是先跑通 Zeabur 上的服务、导入和已有会话签到，`SITE_LOGIN_PROFILES_JSON` 可以先填 `{}`，目标站点选择器可以放到第二阶段再补。

如果还没有 `TG_ADMIN_CHAT_ID`，可以先给机器人发送一条私聊消息，再通过 Telegram Bot API 的 `getUpdates` 查看 `chat.id`。

## 3. Zeabur 环境变量与 Secrets

### Secret

以下内容放进 Zeabur Secret：

```text
DATABASE_URL
TG_BOT_TOKEN
TG_WEBHOOK_SECRET
TG_ADMIN_CHAT_ID
INTERNAL_ADMIN_TOKEN
LOCAL_WORKER_TOKEN
GITHUB_USERNAME
GITHUB_PASSWORD
GITHUB_TOTP_SECRET
IMPORT_GITHUB_PAT
SITE_LOGIN_PROFILES_JSON
```

说明：

- `DATABASE_URL` 推荐直接使用 Zeabur PostgreSQL 暴露出来的连接串
- 如果只拿到了 `POSTGRES_CONNECTION_STRING`，可以不填 `DATABASE_URL`
- `TG_WEBHOOK_SECRET` 建议使用 48 到 64 位随机字符串
- `INTERNAL_ADMIN_TOKEN` 建议使用 48 到 64 位随机字符串
- `LOCAL_WORKER_TOKEN` 建议使用另一组独立的 48 到 64 位随机字符串，不要与 `INTERNAL_ADMIN_TOKEN` 复用
- `GITHUB_TOTP_SECRET` 必须是 GitHub TOTP setup key，不是一次性验证码
- `SITE_LOGIN_PROFILES_JSON` 首轮部署可以直接填 `{}`；只有在开始配置自动续期时，才需要替换成单行 JSON
- 如果你启用了本文档后面提到的“部署阶段 Telegram 通知”，`TG_BOT_TOKEN` 与 `TG_ADMIN_CHAT_ID` 也要能在 Docker build 阶段读取到；当前代码会复用同一只管理员私聊机器人

可直接照着填写的首轮 Secret 模板：

```text
DATABASE_URL=<Zeabur PostgreSQL connection string>
TG_BOT_TOKEN=<BotFather token>
TG_WEBHOOK_SECRET=<random 48-64 chars>
TG_ADMIN_CHAT_ID=<your telegram private chat id>
INTERNAL_ADMIN_TOKEN=<random 48-64 chars>
LOCAL_WORKER_TOKEN=<random 48-64 chars>
GITHUB_USERNAME=<your github username>
GITHUB_PASSWORD=<your github password>
GITHUB_TOTP_SECRET=<your github totp setup key>
IMPORT_GITHUB_PAT=<github pat with repo contents read access>
SITE_LOGIN_PROFILES_JSON={}
```

同样内容也可以直接参考 [docs/zeabur-secrets.example.txt](/E:/all-api-hub/docs/zeabur-secrets.example.txt)。

### Env

以下内容放进 Zeabur Env：

```text
ALL_API_HUB_DATA_DIR=/data/all-api-hub
CHROMIUM_PATH=/usr/bin/chromium
LINUXDO_BASE_URL=https://linux.do
IMPORT_REPO_OWNER=jctn
IMPORT_REPO_NAME=all-api-hub-cloud
IMPORT_REPO_PATH=all-api-hub-backup-2026-03-19.json
IMPORT_REPO_REF=main
TZ=Asia/Shanghai
```

说明：

- `PORT` 由 Zeabur 注入，不手工覆盖
- `IMPORT_REPO_REF` 默认使用 `main`
- `ALL_API_HUB_DATA_DIR` 必须指向 Volume 内目录
- `CHROMIUM_PATH` 用于让 Playwright 直接启动容器里的系统 Chromium
- 上面这组 `IMPORT_REPO_*` 适用于当前仓库根目录的正式备份文件 `all-api-hub-backup-2026-03-19.json`
- 如果你的正式备份文件在别的仓库或别的路径，只替换 `IMPORT_REPO_OWNER`、`IMPORT_REPO_NAME`、`IMPORT_REPO_PATH`、`IMPORT_REPO_REF`
- 仓库根目录的 `tmp-import.json` 只是烟测样例，不建议作为正式导入源
- 如果你把 `site-login-profiles.json` 也放在私有数据仓库里，推荐额外设置 `SITE_LOGIN_PROFILES_REPO_PATH=site-login-profiles.json`

可直接参考 [packages/server/.env.example](/E:/all-api-hub/packages/server/.env.example)。
也可以直接参考 [docs/zeabur-env.example.txt](/E:/all-api-hub/docs/zeabur-env.example.txt)。

## 4. `SITE_LOGIN_PROFILES_JSON` 提供方式

如果你当前只是为了让服务先启动、打通导入与已有会话签到，可以把 `SITE_LOGIN_PROFILES_JSON` 先设为：

```json
{}
```

这时服务会正常启动，但 `/auth_refresh all` 对未配置 profile 的站点可能返回 `unsupported_auto_reauth`，属于预期表现。

更推荐的长期方式是：

1. 在私有数据仓库中维护 `site-login-profiles.json`
2. 在 Zeabur Env 中设置 `SITE_LOGIN_PROFILES_REPO_PATH=site-login-profiles.json`
3. 服务启动时自动从 GitHub 私有仓库加载该文件

默认情况下，如果你不显式设置 `SITE_LOGIN_PROFILES_REPO_OWNER/NAME/REF/GITHUB_PAT`，服务会直接复用：

- `IMPORT_REPO_OWNER`
- `IMPORT_REPO_NAME`
- `IMPORT_REPO_REF`
- `IMPORT_GITHUB_PAT`

也就是说，最常见的做法就是把账号备份 JSON 和 `site-login-profiles.json` 放在同一个私有数据仓库里统一管理。

JSON 结构固定为“以 hostname 为 key 的对象”，示例：

```json
{
  "demo.example.com": {
    "executionMode": "local-browser",
    "loginPath": "/auth/login",
    "loginButtonSelectors": [
      "button[data-provider='linuxdo']",
      "a[href*='linux.do']"
    ],
    "successUrlPatterns": [
      "/console",
      "/dashboard"
    ],
    "tokenStorageKeys": [
      "access_token",
      "token"
    ],
    "postLoginSelectors": [
      ".user-avatar",
      ".account-menu"
    ]
  }
}
```

字段规则：

- `executionMode`
  可选；`cloud` 表示继续走 Zeabur 容器内浏览器，`local-browser` 表示转交本地 worker；不填时默认 `cloud`
- `loginPath`
  登录页路径；不填时代码默认 `/`
- `loginButtonSelectors`
  必填；用于在目标站点点击 Linux.do 或 GitHub 登录入口
- `successUrlPatterns`
  可选；URL 命中任一片段就视为成功
- `tokenStorageKeys`
  可选；不填时默认依次尝试 `access_token`、`token`、`api_token`、`authorization`
- `postLoginSelectors`
  可选；页面上有这些元素也会视为成功

推荐流程：

1. 本地维护 `site-login-profiles.json`
2. 用浏览器 DevTools 确认目标站点登录按钮选择器
3. 确认 JSON 合法
4. 压成单行后粘贴到 Zeabur Secret `SITE_LOGIN_PROFILES_JSON`

推荐选择器策略：

- 优先使用稳定属性：`data-provider`、`href*='linux.do'`、`href*='github'`
- 避免只依赖按钮文案
- 如果登录成功后有头像、用户菜单、用户栏，优先放进 `postLoginSelectors`

可直接参考 [examples/site-login-profiles.example.json](/E:/all-api-hub/examples/site-login-profiles.example.json)。

## 4.1 Mixed-Mode 路由

如果某个站点已经确认需要真实机器浏览器，例如会频繁触发 Cloudflare Turnstile 或需要人工偶发接管，推荐直接在 `site-login-profiles.json` 中把该 hostname 标记为：

```json
{
  "target.example.com": {
    "executionMode": "local-browser",
    "loginPath": "/login",
    "loginButtonSelectors": ["a[href*='linux.do']"]
  }
}
```

这样系统行为会变成：

1. TG 指令仍然发给云端 bot
2. 云端按站点分流，把该 host 的浏览器任务入队到本地 worker
3. 本地 worker 用真实可见 Chromium 执行
4. 云端只记录任务与结果摘要，不保存本地浏览器实时会话

worker 的本地部署和 `.env` 模板见 [docs/local-browser-worker.md](/E:/all-api-hub/docs/local-browser-worker.md) 与 [packages/worker/.env.example](/E:/all-api-hub/packages/worker/.env.example)。

## 5. 首次部署步骤

1. 确认 PostgreSQL 服务可用。
2. 新建或确认 `All API Hub server` 服务，代码源指向当前仓库。
3. 给 server 服务挂载 Volume 到 `/data`。
4. 设置 `ALL_API_HUB_DATA_DIR=/data/all-api-hub`。
5. 配齐全部 Secret 与 Env。
6. 如果是首轮部署，先将 `SITE_LOGIN_PROFILES_JSON` 设为 `{}`。
7. 部署方式选择仓库根目录 `Dockerfile`。
8. 等待服务启动后访问：

```text
GET https://<your-zeabur-domain>/internal/healthz
```

预期响应至少包含：

```json
{
  "ok": true,
  "storageMode": "postgres",
  "latestMigrationId": "001_init_postgres_storage"
}
```

## 5.1 部署阶段 Telegram 通知

当前代码支持在 Zeabur 的以下阶段向管理员私聊发送通知：

- 开始构建
- 构建成功
- 构建失败
- 启动中
- 运行中

实现方式：

- 构建阶段：根目录 `Dockerfile` 的 `build` stage 会运行 `packages/server/scripts/zeabur-build-notify.mjs`
- 运行阶段：`packages/server/src/index.ts` 会在服务初始化前发送“启动中”，在 `server.listen(...)` 成功后发送“运行中”
- 所有通知都走当前已有的 `TG_BOT_TOKEN + TG_ADMIN_CHAT_ID`
- 通知发送失败只会打印 warning / error，不会阻断 Docker build 或服务启动

注意事项：

- 因为“开始构建 / 构建成功 / 构建失败”发生在应用尚未启动时，所以这三类消息不是复用 `grammy` 机器人实例，而是由构建脚本直接调用 Telegram Bot API
- `运行中` 的定义是服务已经完成初始化并成功监听端口，不额外等待 Zeabur 控制台状态变绿
- 如果 Zeabur 的 Docker build 环境没有把 `TG_BOT_TOKEN` 或 `TG_ADMIN_CHAT_ID` 注入到 build stage，构建本身仍会继续，只是构建期通知会降级为日志告警

9. 设置 Telegram webhook：

```bash
curl -X POST "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook" -d "url=https://<your-zeabur-domain>/telegram/webhook" -d "secret_token=<TG_WEBHOOK_SECRET>"
```

10. 通过 Telegram 依次执行：

- `/sync_import`
- `/accounts`
- `/checkin_all`

11. 只有在开始配置自动续期时，再补 `SITE_LOGIN_PROFILES_JSON` 并测试 `/auth_refresh all`。

## 6. OpenClaw / 内部接口调用方式

### 健康检查

```bash
curl "https://<your-zeabur-domain>/internal/healthz"
```

### 同步导入

```bash
curl -X POST "https://<your-zeabur-domain>/internal/import/sync" -H "Authorization: Bearer <INTERNAL_ADMIN_TOKEN>"
```

### 批量签到

```bash
curl -X POST "https://<your-zeabur-domain>/internal/checkin/run" -H "Authorization: Bearer <INTERNAL_ADMIN_TOKEN>" -H "Content-Type: application/json" -d "{}"
```

### 单账号签到

```bash
curl -X POST "https://<your-zeabur-domain>/internal/checkin/run" -H "Authorization: Bearer <INTERNAL_ADMIN_TOKEN>" -H "Content-Type: application/json" -d "{\"accountId\":\"<account-id>\"}"
```

### 刷新全部账号会话

```bash
curl -X POST "https://<your-zeabur-domain>/internal/auth/refresh" -H "Authorization: Bearer <INTERNAL_ADMIN_TOKEN>" -H "Content-Type: application/json" -d "{}"
```

## 7. 验收标准

首轮最小验收顺序：

1. `GET /internal/healthz` 返回 `storageMode: "postgres"`
2. `/sync_import` 可从私有仓库导入 JSON
3. `/accounts` 可读到账户摘要
4. `/checkin_all` 在已有有效会话下能跑完一轮
5. 并发触发两个任务时，后一个任务收到“已有任务执行中”
6. 重启服务后：
   PostgreSQL 中账号与签到历史仍在，且 `/data/all-api-hub/profiles/cloud/linuxdo-github` 与 `/data/all-api-hub/diagnostics` 仍在。

自动续期配置补全后的附加验收：

1. `/auth_refresh all` 至少能完成一个真实站点会话刷新
2. 清空某账号 cookie/token 后，再次 `/checkin_all` 能触发一次自动续期并回写 PostgreSQL

## 8. 常见排查

### `healthz` 不是 `storageMode: "postgres"`

- 检查 `DATABASE_URL` 或 `POSTGRES_CONNECTION_STRING` 是否正确注入
- 检查 server 是否误用了旧的文件仓储配置

### `SITE_LOGIN_PROFILES_JSON` 配了但站点仍显示 `unsupported_auto_reauth`

- 检查顶层 key 是否是目标 hostname
- 检查该 profile 是否缺少 `loginButtonSelectors`
- 检查站点实际域名是否与配置完全一致，或是否需要 `*.example.com`

### `/auth_refresh all` 返回 `manual_action_required`

- 目标站点或 GitHub 遇到 Turnstile、Cloudflare、CAPTCHA
- GitHub 出现额外邮件验证、security key、passkey
- 登录按钮选择器失效

### `/sync_import` 失败

- 如果报 `GitHub 导入失败，HTTP 401` 或 `HTTP 403`：
  - 检查 `IMPORT_GITHUB_PAT` 是否有效，且是否仍有读取目标仓库内容的权限
- 如果报 `GitHub 导入失败，HTTP 404`：
  - 检查 `IMPORT_REPO_OWNER/NAME/PATH/REF` 是否有一项写错
  - 私有仓库在 PAT 无权访问时，GitHub 也可能返回 `404`
- 检查正式导入文件是否是原扩展导出的 JSON 结构
- 检查是否误把仓库根目录的 `tmp-import.json` 烟测样例当成正式导入源
