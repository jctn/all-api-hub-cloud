# 本地浏览器 Worker Runbook

适用场景：

- Zeabur 上的 `packages/server` 已经可用
- 你希望继续通过 Telegram 指令触发任务
- 某些站点必须依赖真实机器浏览器，不能稳定跑在云端 headless Chromium 里

## 1. 角色分工

mixed-mode 下各层职责固定为：

- 云端 `packages/server`
  接收 TG 指令、分流站点、入队本地任务、汇总结果、写历史
- 本地 `packages/worker`
  拉取需要真实浏览器的任务，启动本机可见 Chromium 执行
- 私有数据目录 `E:/all-api-hub-private-data`
  只作为种子配置和人工维护源，不保存运行中的浏览器实时会话
- 本地 runtime
  保存浏览器 profile、cookie、localStorage、diagnostics、worker 日志

## 2. 服务器侧前置条件

Zeabur server 至少要满足以下条件：

- 已配置 `LOCAL_WORKER_TOKEN`
- `site-login-profiles.json` 已能被 server 读取
- 需要本地执行的 host 已显式标记 `executionMode: "local-browser"`

最小 profile 示例：

```json
{
  "runanytime.example.com": {
    "executionMode": "local-browser",
    "loginPath": "/login",
    "loginButtonSelectors": [
      "a[href*='linux.do']",
      "button[data-provider='github']"
    ],
    "successUrlPatterns": ["/console"],
    "tokenStorageKeys": ["access_token", "token"],
    "postLoginSelectors": [".user-avatar"]
  }
}
```

## 3. 本地环境变量

建议从 [packages/worker/.env.example](/E:/all-api-hub/packages/worker/.env.example) 复制一份本地 `.env`。`npm run start:worker` 和 `npm run dev:worker` 会自动读取 `packages/worker/.env`，并在存在时继续叠加 `packages/worker/.env.local`。

必填变量：

- `ALL_API_HUB_SERVER_URL`
  Zeabur server 的公开 URL，例如 `https://your-zeabur-domain.example.com`
- `LOCAL_WORKER_TOKEN`
  必须与 Zeabur 上配置的 `LOCAL_WORKER_TOKEN` 一致
- `ALL_API_HUB_PRIVATE_DATA_DIR`
  你的私有数据目录，例如 `E:/all-api-hub-private-data`
- `GITHUB_USERNAME`
- `GITHUB_PASSWORD`
- `GITHUB_TOTP_SECRET`

可选变量：

- `LOCAL_WORKER_ID`
  默认 `local-browser-1`
- `ALL_API_HUB_DATA_DIR`
  本地 runtime 根目录；不填时 Windows 默认 `%LOCALAPPDATA%/all-api-hub-worker`
- `CHROMIUM_PATH`
  指向本机 Chrome/Chromium 可执行文件

## 4. 本地 runtime 目录

默认目录：

- Windows: `%LOCALAPPDATA%/all-api-hub-worker`

worker 会在 runtime 目录下维护：

- `accounts.json`
- `checkin-history.json`
- `profiles/sites/<accountId>/`
- `diagnostics/`
- `logs/`

注意：

- `E:/all-api-hub-private-data` 是只读种子/config 仓库，不建议直接作为 runtime 写入目录
- 浏览器实时 session 只保存在 runtime，不回写云端 PostgreSQL cookie/token

## 5. 启动方式

首次运行建议先构建：

```bash
npm run build --workspace @all-api-hub/browser --workspace @all-api-hub/core --workspace @all-api-hub/server --workspace @all-api-hub/worker
```

然后启动本地 worker：

```bash
npm run start:worker
```

开发调试时可以直接：

```bash
npm run dev:worker
```

Windows 下如果你想直接双击启动，也可以用仓库根目录的批处理：

- `worker-dev.bat`
  先构建 `browser/core/server/worker`，再用 `npm run dev:worker` 以源码调试模式启动
- `worker-keepalive.bat`
  先构建一次，再用 `npm run start:worker` 长期运行；如果 worker 异常退出，会在 5 秒后自动拉起

这两个批处理都会优先检查 `packages/worker/.env` 或 `packages/worker/.env.local` 是否存在；如果都不存在，会直接提示你先从 `.env.example` 复制并填写本地密钥。

## 6. 运行行为

worker 运行时的固定行为：

- 空闲时只做轻量轮询和心跳，不常驻浏览器
- 拉到任务后才启动本机可见 Chromium
- 每个账号使用独立持久化 profile 目录
- 执行完成后保留 profile，以便后续复用登录态

如果任务里出现以下情况：

- Cloudflare
- Turnstile
- 站点要求额外手动登录

worker 会把任务进度上报为 `waiting_manual`，并尽量保留浏览器窗口给本机人工接管。人工完成后，只要页面进入登录成功状态，后续流程会继续执行。

## 7. 烟测顺序

建议按这个顺序做端到端联调：

1. 确认 Zeabur 的 `/internal/healthz` 正常
2. 在 `site-login-profiles.json` 里把一个测试站点标记成 `executionMode: "local-browser"`
3. 启动本地 worker
4. 在 TG 里执行 `/status`
5. 在 TG 里执行 `/checkin <该站点账号>`
6. 确认任务被本地浏览器接管，且最终结果仍由 TG 返回

## 8. 常见排查

### worker 一直领不到任务

- 检查 `LOCAL_WORKER_TOKEN` 是否与云端一致
- 检查目标站点 profile 是否真的设置了 `executionMode: "local-browser"`
- 检查 TG 指令是否命中了正确账号

### 浏览器没有打开

- 检查本机是否能正常启动 Playwright 对应的 Chromium
- 如有必要，显式设置 `CHROMIUM_PATH`
- 检查 worker 终端是否已报 `claim task failed` 或 `execute task failed`

### 任务在 TG 里显示 `manual_action_required`

- 本地 worker 未在线，超过 claim timeout
- 站点流程仍未完成，或人工接管后未进入成功状态
- 目标站点本身已经不再匹配当前的登录按钮选择器
