# All API Hub

当前仓库同时包含三种运行形态：

- `packages/core`: 共享类型、存储、导入解析、签到执行引擎
- `packages/cli`: 本地 CLI，供 OpenClaw 或本地任务调用
- `packages/desktop`: Electron 桌面版，负责账号管理、导入、手动登录、手动签到
- `packages/server`: Zeabur 云端服务，负责 GitHub 仓库同步导入、Telegram 指令、Playwright 自动登录续期、云端批量签到

## 开发

```bash
npm install
npm run build
npm run test
```

常用命令：

```bash
npm run dev:desktop
npm run dev:server
npm run start:desktop
npm run start:server
```

## 本地 CLI

构建后可直接调用：

```bash
node packages/cli/dist/index.js import <backup.json>
node packages/cli/dist/index.js accounts list
node packages/cli/dist/index.js checkin run
node packages/cli/dist/index.js checkin run --account <accountId>
```

默认数据目录：

- Windows: `%LOCALAPPDATA%\\all-api-hub-desktop`
- 也可以通过环境变量 `ALL_API_HUB_DATA_DIR` 指定自定义目录

`checkin run` 的退出语义：

- 全部成功或已签到: 退出码 `0`
- 存在失败或需要人工处理: 退出码 `1`

## 桌面版发布

统一发布命令：

```bash
npm run release:desktop
```

这个命令会执行以下流程：

- 清理 `packages/desktop/dist-electron`
- 清理 `packages/desktop/dist-renderer`
- 清理 `packages/desktop/release`
- 清理历史临时目录 `packages/desktop/release-*`
- 重新构建 workspace
- 重新打包桌面版到唯一正式目录 `packages/desktop/release`

打包前请先关闭正在运行的桌面版 `exe`，否则 Windows 可能会因为文件占用导致清理失败。

## 云端版

云端版入口在 `packages/server`，部署形态固定为：

- Zeabur 单实例
- Dockerfile 部署
- PostgreSQL 保存结构化业务数据
- Volume 挂载到 `/data`
- `ALL_API_HUB_DATA_DIR=/data/all-api-hub`
- Telegram webhook 模式
- Playwright Chromium 持久化 profile 与 diagnostics 继续落到 Volume

完整部署说明见 [docs/zeabur-server-deployment.md](/E:/all-api-hub/docs/zeabur-server-deployment.md)。
配置模板见 [packages/server/.env.example](/E:/all-api-hub/packages/server/.env.example) 和 [examples/site-login-profiles.example.json](/E:/all-api-hub/examples/site-login-profiles.example.json)。
Zeabur 可直接复制的配置清单见 [docs/zeabur-secrets.example.txt](/E:/all-api-hub/docs/zeabur-secrets.example.txt) 和 [docs/zeabur-env.example.txt](/E:/all-api-hub/docs/zeabur-env.example.txt)。

服务启动：

```bash
npm run build --workspace @all-api-hub/core --workspace @all-api-hub/server
npm run start --workspace @all-api-hub/server
```

### Telegram 指令

- `/sync_import`
- `/checkin_all`
- `/checkin <accountId>`
- `/auth_refresh <accountId|all>`
- `/accounts`
- `/status`

### 内部接口

- `GET /internal/healthz`
- `POST /internal/import/sync`
- `POST /internal/checkin/run`
- `POST /internal/auth/refresh`

内部接口统一要求：

```http
Authorization: Bearer <INTERNAL_ADMIN_TOKEN>
```

### 关键环境变量

```text
PORT
DATABASE_URL
ALL_API_HUB_DATA_DIR=/data/all-api-hub
CHROMIUM_PATH=/usr/bin/chromium
TG_BOT_TOKEN
TG_WEBHOOK_SECRET
TG_ADMIN_CHAT_ID
INTERNAL_ADMIN_TOKEN
GITHUB_USERNAME
GITHUB_PASSWORD
GITHUB_TOTP_SECRET
LINUXDO_BASE_URL=https://linux.do
IMPORT_REPO_OWNER
IMPORT_REPO_NAME
IMPORT_REPO_PATH
IMPORT_REPO_REF
IMPORT_GITHUB_PAT
SITE_LOGIN_PROFILES_JSON
TZ=Asia/Shanghai
```

说明：

- `DATABASE_URL` 优先使用 Zeabur PostgreSQL 的连接串
- 若未设置 `DATABASE_URL`，服务会 fallback 到 `POSTGRES_CONNECTION_STRING`
- `packages/server` 不再把 `accounts.json`、`app-settings.json`、`checkin-history.json` 作为主存储
- PostgreSQL 只存账号、设置、签到运行记录和账号签到状态
- `/data/all-api-hub/profiles/cloud/linuxdo-github` 继续保存共享 SSO 浏览器 profile
- `/data/all-api-hub/diagnostics` 继续保存截图和诊断文件
- 容器内如果使用系统 Chromium，请设置 `CHROMIUM_PATH=/usr/bin/chromium`
- `SITE_LOGIN_PROFILES_JSON` 首轮部署可以先填 `{}`，这样服务可正常启动，只是暂不启用站点自动续期
- 更推荐把 `site-login-profiles.json` 放进私有数据仓库，再通过 `SITE_LOGIN_PROFILES_REPO_PATH` 在启动时自动加载
- 当前仓库默认导入源推荐使用 `jctn/all-api-hub-cloud` 的 `all-api-hub-backup-2026-03-19.json@main`
- 仓库根目录的 `tmp-import.json` 只是烟测样例，不建议作为正式导入源

推荐的 Zeabur Secret / Env 分组：

- Secret:
  `DATABASE_URL` 或 `POSTGRES_CONNECTION_STRING`、`TG_BOT_TOKEN`、`TG_WEBHOOK_SECRET`、`TG_ADMIN_CHAT_ID`、`INTERNAL_ADMIN_TOKEN`、`GITHUB_USERNAME`、`GITHUB_PASSWORD`、`GITHUB_TOTP_SECRET`、`IMPORT_GITHUB_PAT`、`SITE_LOGIN_PROFILES_JSON={}`
- Env:
  `ALL_API_HUB_DATA_DIR=/data/all-api-hub`、`CHROMIUM_PATH=/usr/bin/chromium`、`LINUXDO_BASE_URL=https://linux.do`、`IMPORT_REPO_OWNER=jctn`、`IMPORT_REPO_NAME=all-api-hub-cloud`、`IMPORT_REPO_PATH=all-api-hub-backup-2026-03-19.json`、`IMPORT_REPO_REF=main`、`SITE_LOGIN_PROFILES_REPO_PATH=site-login-profiles.json`、`TZ=Asia/Shanghai`

首轮 Zeabur Secret 模板：

```text
DATABASE_URL=<Zeabur PostgreSQL connection string>
TG_BOT_TOKEN=<BotFather token>
TG_WEBHOOK_SECRET=<random 48-64 chars>
TG_ADMIN_CHAT_ID=<your telegram private chat id>
INTERNAL_ADMIN_TOKEN=<random 48-64 chars>
GITHUB_USERNAME=<your github username>
GITHUB_PASSWORD=<your github password>
GITHUB_TOTP_SECRET=<your github totp setup key>
IMPORT_GITHUB_PAT=<github pat with repo contents read access>
SITE_LOGIN_PROFILES_JSON={}
```

推荐的 Zeabur Env 模板：

```text
ALL_API_HUB_DATA_DIR=/data/all-api-hub
CHROMIUM_PATH=/usr/bin/chromium
LINUXDO_BASE_URL=https://linux.do
IMPORT_REPO_OWNER=jctn
IMPORT_REPO_NAME=all-api-hub-cloud
IMPORT_REPO_PATH=all-api-hub-backup-2026-03-19.json
IMPORT_REPO_REF=main
SITE_LOGIN_PROFILES_REPO_PATH=site-login-profiles.json
TZ=Asia/Shanghai
```

`SITE_LOGIN_PROFILES_JSON` 示例：

```json
{
  "demo.example.com": {
    "loginPath": "/auth/login",
    "loginButtonSelectors": [
      "button[data-provider='linuxdo']",
      "a[href*='linux.do']"
    ],
    "successUrlPatterns": ["/console", "/dashboard"],
    "tokenStorageKeys": ["access_token", "token"],
    "postLoginSelectors": [".user-avatar", ".account-menu"]
  }
}
```

如果你把站点 profile 文件放在私有数据仓库中，推荐直接设置：

```text
IMPORT_REPO_OWNER=jctn
IMPORT_REPO_NAME=all-api-hub-private-data
IMPORT_REPO_PATH=all-api-hub-backup-2026-03-19.json
IMPORT_REPO_REF=main
SITE_LOGIN_PROFILES_REPO_PATH=site-login-profiles.json
```

这时服务会在启动时自动从同一私有仓库读取 `site-login-profiles.json`，不再需要手工把大段 JSON 复制进 `SITE_LOGIN_PROFILES_JSON`。

### Zeabur 部署

1. 挂载 Volume 到 `/data`
2. 连接 PostgreSQL，并设置 `DATABASE_URL`
3. 设置 `ALL_API_HUB_DATA_DIR=/data/all-api-hub`
4. 使用仓库根目录 `Dockerfile`
5. 首轮部署时可先将 `SITE_LOGIN_PROFILES_JSON` 设为 `{}`
6. 将 Zeabur HTTPS 域名配置到 Telegram webhook

示例 webhook：

```text
https://<your-zeabur-domain>/telegram/webhook
```

## Docker

仓库根目录已经提供 `Dockerfile`，用于构建 `core + server`，不会构建 Electron 桌面版。

## 打包产物

Windows 安装包路径：

```text
packages/desktop/release/All API Hub Desktop Setup 0.1.0.exe
```

Windows 免安装版本路径：

```text
packages/desktop/release/win-unpacked/All API Hub Desktop.exe
```
