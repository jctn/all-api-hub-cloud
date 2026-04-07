# 本地浏览器 FlareSolverr 预热设计

日期：2026-04-07

## 背景

当前仓库已经存在两条相关能力：

- 云端 `FlareSolverr` 接入，供 server 侧自动登录流程在 Cloudflare 挑战阶段使用
- `executionMode: "local-browser"` 的本地 worker，用真实本地 Chrome 承接部分站点的登录与签到

现有问题是：

- `RunAnytime` 这类站点在本地浏览器签到时，Cloudflare / Turnstile 挑战会打断自动链路
- 用户是远程通过 TG 发起签到，不适合依赖人工在本机窗口里兜底
- 当前站点 profile 只能表达“走云端还是走本地浏览器”，不能表达“本地浏览器站点是否需要先走 FlareSolverr 预热”

目标是新增一条“本地 FlareSolverr 预热”链路，只服务本地浏览器模式，并尽量把人工兜底降到最后一层，甚至对特定站点直接禁用人工兜底。

## 目标

- 为本地浏览器 worker 新增一套独立于云端 server 的 FlareSolverr 能力
- 让能力是全局可用的，但是否启用由站点 profile 显式控制
- 在真实本地 Chrome 打开站点前，优先通过本地 FlareSolverr 预热获取 challenge cookie 与 user-agent
- 对 `RunAnytime` 优先实现“根页预热 -> 打开根页 -> 自动判断是否需要重新登录 -> 自动签到”
- 远程触发时优先自动成功或自动失败，不轻易停在人工等待态
- 提供足够清晰的 TG 进度文案和本地结构化日志，便于远程排障

## 非目标

- 不改动 Zeabur 上现有云端 FlareSolverr 的职责
- 不让 worker 负责启动或停止 Docker 容器
- 不尝试做无限次挑战重试
- 不在本轮设计里引入新的远端控制通道或浏览器远程桌面机制

## 现状约束

### 云端 FlareSolverr

当前 `FlareSolverr` 能力通过 `config.flareSolverrUrl` 注入，主要在 [packages/server/src/auth/playwrightSessionService.ts](/E:/all-api-hub/packages/server/src/auth/playwrightSessionService.ts) 的自动登录和挑战补救流程里使用。

### 本地 worker

本地 worker 通过 [packages/worker/src/processor.ts](/E:/all-api-hub/packages/worker/src/processor.ts) 构造 `PlaywrightSiteSessionConfig`，再复用 [packages/server/src/auth/playwrightSessionService.ts](/E:/all-api-hub/packages/server/src/auth/playwrightSessionService.ts) 完成签到。

### 站点 profile

当前 profile 结构定义在 [packages/browser/src/siteLoginProfiles.ts](/E:/all-api-hub/packages/browser/src/siteLoginProfiles.ts)，只能表达登录路径、按钮选择器和 `executionMode`，还不能表达本地浏览器下的挑战策略。

## 方案选择

最终采用：

- `Docker 常驻本地 FlareSolverr`
- `worker 提供本地 FlareSolverr 能力，但按站点 profile 显式启用`
- `预热优先，人工兜底最后`

未采用方案：

- 所有 `local-browser` 站点统一默认先走 FlareSolverr：副作用太大
- 只在真实浏览器已经撞到 Cloudflare 后再回退调用 FlareSolverr：对远程触发不够稳定

## 总体设计

### 1. 配置模型

新增两层配置。

#### Worker 全局配置

在本地 worker 环境变量中新增：

- `LOCAL_FLARESOLVERR_ENABLED=true|false`
- `LOCAL_FLARESOLVERR_URL=http://127.0.0.1:8191`
- `LOCAL_FLARESOLVERR_TIMEOUT_MS=90000`

职责：

- 只表示本地是否具备 FlareSolverr 能力
- 不负责表达哪个站点要用
- 不与云端 `flareSolverrUrl` 混用

#### 站点级 profile 配置

在 `site-login-profiles.json` 的站点定义中新增 `localBrowser` 子对象，而不是继续平铺布尔字段。

推荐结构：

```json
{
  "runanytime.hxi.me": {
    "executionMode": "local-browser",
    "loginPath": "/login",
    "loginButtonSelectors": [
      "button[data-provider='linuxdo']",
      "a[data-provider='linuxdo']"
    ],
    "successUrlPatterns": ["/console"],
    "tokenStorageKeys": ["access_token", "token"],
    "postLoginSelectors": [],
    "localBrowser": {
      "cloudflareMode": "prewarm",
      "flareSolverrScope": "root",
      "flareSolverrTargetPath": "/",
      "allowRetryAfterBrowserChallenge": true,
      "openRootBeforeCheckin": true,
      "manualFallbackPolicy": "disabled"
    }
  }
}
```

字段语义：

- `cloudflareMode`
  - `off`
  - `prewarm`
- `flareSolverrScope`
  - `root`
  - `login`
  - `checkin`
- `flareSolverrTargetPath`
  - 覆盖默认预热路径
- `allowRetryAfterBrowserChallenge`
  - 浏览器过程中再次命中挑战时，是否允许一次额外预热
- `openRootBeforeCheckin`
  - 预热后真实浏览器是否必须先打开根页
- `manualFallbackPolicy`
  - `disabled`
  - `last-resort`

兼容性策略：

- 没有 `localBrowser` 子对象：完全按旧逻辑
- 有 `localBrowser` 但没写 `cloudflareMode`：视为 `off`
- 不因为 `executionMode: "local-browser"` 自动开启 FlareSolverr

### 2. 本地 worker 执行链路

推荐把本地 FlareSolverr 放在 `worker -> PlaywrightSiteSessionService` 之间，做成“挑战预热层”。

执行顺序：

1. worker 收到任务并解析站点 profile
2. 如果站点未显式启用本地 FlareSolverr，走旧的本地浏览器流程
3. 如果站点启用了本地 FlareSolverr，先做一次本地服务探活
4. 探活通过后，对目标 URL 做一次预热请求
5. 先拿到 `cookies + userAgent`
6. 再启动真实本地 Chrome / Playwright 持久化上下文
7. 先注入 FlareSolverr challenge cookie
8. 再叠加账号已有站点 cookie
9. 然后按站点策略打开根页 / 登录页 / 签到页
10. 继续自动登录与自动签到

核心原则：

- 不是“浏览器被 challenge 卡住后才补救”
- 而是“先预热，再打开真实浏览器”

### 3. RunAnytime 专门化链路

对 `RunAnytime`，推荐固定为：

1. 本地 FlareSolverr 预热 `https://runanytime.hxi.me/`
2. 启动真实本地 Chrome，并同步 challenge cookie 与 user-agent
3. 再注入账号原有站点 cookie
4. 打开根页 `https://runanytime.hxi.me/`
5. 如果已落到 `/console/...`，继续签到
6. 如果跳到 `/login?expired=true`，立即进入自动 SSO 登录
7. 如果 SSO 中再次命中 Cloudflare，允许一次额外预热
8. 登录成功后再进入签到流

这条链路避免了“刚打开就直接冲签到页”的错误时序。

### 4. 挑战重试策略

浏览器过程中如果再次遇到 Cloudflare：

- 只允许一次额外预热
- 重试 URL 使用当前页面 URL
- 预热成功后重新注入 cookie，并刷新当前页面

不允许无限循环，否则会出现反复刷新或长期卡死。

## 失败回退策略

本地浏览器站点统一遵循：

1. 本地 FlareSolverr 预热
2. 自动登录 / 自动签到
3. 浏览器过程中一次额外预热
4. 仍失败时，按站点策略决定直接失败还是人工兜底

### 推荐策略

对 `RunAnytime`，推荐：

- `manualFallbackPolicy: "disabled"`

也就是：

- 本地 FlareSolverr 不可用：直接失败
- 预热失败：直接失败
- 自动登录失败：直接失败
- 额外预热后仍失败：直接失败
- 不进入人工等待

原因：

- 用户通过 TG 远程发起签到
- 人工窗口等待对该场景价值低
- 远程语义应是“自动成功”或“自动失败且给出明确原因”

适合旁边有人值守的站点，才使用：

- `manualFallbackPolicy: "last-resort"`

## 日志与远程可观测性

### TG 进度文案

建议将进度文案固定成可观察阶段：

- 命中本地 FlareSolverr 预热策略
- 检查本地 FlareSolverr 可用性
- 开始预热站点根页
- FlareSolverr 返回多少个 cookie
- 是否同步 UA
- 启动真实本地 Chrome
- 打开根页
- 是否跳到 `/login?expired=true`
- 是否开始自动 SSO
- 是否再次命中 Cloudflare
- 是否触发额外预热
- 最终成功 / 最终失败

### 本地结构化日志

worker 本地日志至少记录：

- `taskId`
- `accountId`
- `siteHost`
- `phase`
- `flareSolverrUsed`
- `flareSolverrSucceeded`
- `flareSolverrCookieCount`
- `currentUrl`
- `manualFallbackEntered`
- `finalCode`

### 失败诊断快照

失败时额外保留：

- 当前 URL
- 页面标题
- 关键 cookie 名称列表（不保存敏感值）
- 是否命中 `/login?expired=true`
- 是否出现 `Just a moment` / `Cloudflare` / `Turnstile`
- 截图路径

## 推荐的错误码

建议补充统一错误码，便于 TG 和日志对齐：

- `local_flaresolverr_unavailable`
- `local_flaresolverr_prewarm_failed`
- `cloudflare_prewarm_exhausted`
- `site_login_expired`
- `browser_challenge_retry_exhausted`
- `manual_fallback_disabled`

## 落地顺序

推荐实现顺序：

1. 扩展 profile schema 与解析逻辑
2. 扩展 worker 配置，加入本地 FlareSolverr URL 与开关
3. 在 worker 侧把本地 challenge 策略透传到 `PlaywrightSiteSessionService`
4. 在 `PlaywrightSiteSessionService` 中加入“预热优先”链路
5. 对 `RunAnytime` 加入“根页优先、`/login?expired=true` 自动重新登录”逻辑
6. 增加 TG 进度文案与本地结构化日志
7. 增加回归测试
8. 最后再考虑是否把同一能力推广到其他 `local-browser` 站点

## 风险与控制

### 风险一：UA 不一致导致 challenge cookie 无效

控制：

- 预热后尽量把 user-agent 同步给 Playwright 上下文
- 不要只同步 HTTP header，必要时在上下文级别同步 UA

### 风险二：旧账号 cookie 与新 challenge cookie 冲突

控制：

- 合并时同名 cookie 以 FlareSolverr 最新值优先
- 只保留必要业务会话 cookie

### 风险三：重复预热导致循环刷新

控制：

- 额外预热只允许一次
- 超限后直接失败，不再打开人工等待

### 风险四：把所有本地站点都绑到 FlareSolverr

控制：

- 必须由站点 profile 显式启用
- 默认保持 `off`

## 最终推荐配置

对 `RunAnytime` 的推荐 profile：

```json
{
  "executionMode": "local-browser",
  "localBrowser": {
    "cloudflareMode": "prewarm",
    "flareSolverrScope": "root",
    "flareSolverrTargetPath": "/",
    "allowRetryAfterBrowserChallenge": true,
    "openRootBeforeCheckin": true,
    "manualFallbackPolicy": "disabled"
  }
}
```

## 结论

最终结论是：

- 云端 FlareSolverr 与本地 FlareSolverr 分离职责
- worker 全局具备本地 FlareSolverr 能力，但是否启用由站点 profile 显式控制
- 对 `RunAnytime` 采取“根页预热优先、自动重新登录优先、人工兜底默认禁用”的策略
- 远程可观测性依赖 TG 阶段日志、本地结构化日志和失败诊断快照

这套设计满足“远程发起签到、尽量避免人工兜底”的目标，同时不会污染现有所有本地浏览器站点。
