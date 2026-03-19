# All API Hub 云端版部署 Runbook

适用场景：

- 已有 Zeabur PostgreSQL 服务
- 准备部署当前仓库中的 `packages/server`
- 希望使用 PostgreSQL 保存结构化数据，Volume 保存 Playwright profile 与 diagnostics

当前代码已经固定的运行约束：

- `packages/server` 启动时优先读取 `DATABASE_URL`，未提供时回退到 `POSTGRES_CONNECTION_STRING`
- `SITE_LOGIN_PROFILES_JSON` 必须是“以 hostname 为 key 的 JSON 对象”
- 单个站点 profile 至少要有 `loginButtonSelectors`
- Playwright 共享 SSO profile 固定落到 `/data/all-api-hub/profiles/cloud/linuxdo-github`
- diagnostics 固定落到 `/data/all-api-hub/diagnostics`
- Telegram 仅允许 `TG_ADMIN_CHAT_ID` 对应的管理员私聊
- 内部 HTTP 接口统一使用 `Authorization: Bearer <INTERNAL_ADMIN_TOKEN>`

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
GITHUB_USERNAME
GITHUB_PASSWORD
GITHUB_TOTP_SECRET
IMPORT_GITHUB_PAT
SITE_LOGIN_PROFILES_JSON
```

说明：

- `DATABASE_URL` 推荐直接使用 Zeabur PostgreSQL 暴露出来的连接串
- 如果只拿到了 `POSTGRES_CONNECTION_STRING`，可以不填 `DATABASE_URL`
- `GITHUB_TOTP_SECRET` 必须是 GitHub TOTP setup key，不是一次性验证码
- `SITE_LOGIN_PROFILES_JSON` 建议先在本地维护 JSON 文件，再压成单行粘贴到 Secret

### Env

以下内容放进 Zeabur Env：

```text
ALL_API_HUB_DATA_DIR=/data/all-api-hub
LINUXDO_BASE_URL=https://linux.do
IMPORT_REPO_OWNER=<your-owner>
IMPORT_REPO_NAME=<your-repo>
IMPORT_REPO_PATH=<path/to/accounts.json>
IMPORT_REPO_REF=main
TZ=Asia/Shanghai
```

说明：

- `PORT` 由 Zeabur 注入，不手工覆盖
- `IMPORT_REPO_REF` 默认使用 `main`
- `ALL_API_HUB_DATA_DIR` 必须指向 Volume 内目录

可直接参考 [packages/server/.env.example](/E:/all-api-hub/packages/server/.env.example)。

## 4. `SITE_LOGIN_PROFILES_JSON` 提供方式

JSON 结构固定为“以 hostname 为 key 的对象”，示例：

```json
{
  "demo.example.com": {
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

## 5. 首次部署步骤

1. 确认 PostgreSQL 服务可用。
2. 新建或确认 `All API Hub server` 服务，代码源指向当前仓库。
3. 给 server 服务挂载 Volume 到 `/data`。
4. 设置 `ALL_API_HUB_DATA_DIR=/data/all-api-hub`。
5. 配齐全部 Secret 与 Env。
6. 部署方式选择仓库根目录 `Dockerfile`。
7. 等待服务启动后访问：

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

8. 设置 Telegram webhook：

```bash
curl -X POST "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook" -d "url=https://<your-zeabur-domain>/telegram/webhook" -d "secret_token=<TG_WEBHOOK_SECRET>"
```

9. 通过 Telegram 依次执行：

- `/sync_import`
- `/accounts`
- `/auth_refresh all`
- `/checkin_all`

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

最小验收顺序：

1. `GET /internal/healthz` 返回 `storageMode: "postgres"`
2. `/sync_import` 可从私有仓库导入 JSON
3. `/accounts` 可读到账户摘要
4. `/auth_refresh all` 至少能完成一个真实站点会话刷新
5. `/checkin_all` 在有效会话下能跑完一轮
6. 清空某账号 cookie/token 后，再次 `/checkin_all` 能触发一次自动续期并回写 PostgreSQL
7. 并发触发两个任务时，后一个任务收到“已有任务执行中”
8. 重启服务后：
   PostgreSQL 中账号与签到历史仍在，且 `/data/all-api-hub/profiles/cloud/linuxdo-github` 与 `/data/all-api-hub/diagnostics` 仍在。

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

- 检查 `IMPORT_REPO_OWNER/NAME/PATH/REF`
- 检查 `IMPORT_GITHUB_PAT` 是否还有读取该仓库的权限
- 检查导入文件是否是原扩展导出的 JSON 结构
