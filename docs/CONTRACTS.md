# 接口契约（四个并行开发者必读）

> 本文件是并行开发的唯一接口真源。**任何模块的导出签名必须与本文一致**，否则集成会失败。
> 若你认为契约有误，先在群里/回报里说明，不要自行改动签名。

## 项目坐标

- 仓库根（也是包根）：`D:\DSH-Files-v2\02-DSH开发\dshapi长连接插件`
- 包名：`dsh-opencode-ip-guard`
- 模块格式：**ESM**（`type: module`），源码直接用 `.js` + `export`
- 唯一运行时依赖：`undici`（已在 `node_modules/undici` 准备好供本地测试）
- 测试框架：Node 内置 `node:test` + `assert/strict`，测试文件后缀 `.test.mjs`
- Node 可执行文件（本机唯一可用）：`D:\deepseek_harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`

## 代码风格（强制）

1. **所有注释必须用简体中文**，且要写「为什么」而不是「做什么」；
2. 每个函数、每个导出、每个非显然的常量都要有注释；
3. 不使用 TypeScript；纯 JS + JSDoc 标注类型；
4. 不引入除 `undici` 以外的第三方依赖；
5. 所有对外行为失败时必须**降级而不是抛穿**（插件崩了不能拖垮 DSH）。

## 文件与责任人

| 文件 | 责任人 |
|---|---|
| `src/probe.js` / `src/lookup.js` / `src/dispatcher.js` | A（net） |
| `src/blacklist.js` / `src/status.js` / `src/guard.js` | B（state） |
| `src/index.js` / `src/client.js` | C（ui） |
| `package.json` / `cordis.patch.yml` / `LICENSE` / `README*` / `.npmignore` / `CHANGELOG.md` / `docs/ACCEPTANCE.md` | D（meta） |
| 集成、审查、验收脚本 `test/acceptance.mjs` | Lead |

---

## 契约 1：`src/blacklist.js`（B 负责）

    /**
     * 创建黑名单容器。纯内存，无 IO，无可观察副作用。
     */
    export function createBlacklist(options)
    // options = { ttlMs?: number, now?: () => number }   // 均可选，向后兼容
    //   ttlMs 默认 300000；now 默认 Date.now（测试可注入假时钟）

返回对象方法：

| 方法 | 签名 | 语义 |
|---|---|---|
| `isBlack` | `(ip: string) => boolean` | 该 IP 是否已被判定为黑洞**且未过期**（过期即视为可用） |
| `markOk` | `(ip: string, ms: number | null) => void` | 标记可用，记录 TLS 握手耗时 |
| `markBlack` | `(ip: string, reason: string) => void` | 标记黑洞，reason 如 `'timeout'` / `'econnrefused'` |
| `rebuild` | `(results: ProbeResult[]) => void` | **用一轮探测结果重建整个黑名单**（清空后按结果重填） |
| `filter` | `(ips: string[]) => string[]` | 剔除黑名单；**若剔除后为空，必须返回原始 ips**（不得返回空数组） |
| `entries` | `() => BlacklistEntry[]` | 返回快照数组，按 IP 字符串排序，供面板展示 |
| `stats` | `() => { ok: number, black: number, total: number }` | 统计 |
| `clear` | `() => void` | 清空 |
| `expiredIps` | `(now?: number) => string[]` | 返回当前已过期的 IP（供 guard 决定是否补探）；排序 |

    ProbeResult = { ip: string, ok: boolean, ms: number | null, error: string | null }
    BlacklistEntry = { ip: string, state: 'ok' | 'black', ms: number | null, error: string | null, at: number, expiresAt: number }

`at` 是 `Date.now()`，表示该条目最后被更新的时间。

---

## 契约 2：`src/probe.js`（A 负责）

    /**
     * 对单个 IP 做 TLS 握手探测（TCP + 完整 TLS，验证证书链），不发任何 HTTP 请求。
     * 连接地址由 ip 决定，SNI 与证书校验使用 servername。
     */
    export function probeIp(ip, opts)
    // opts = { servername: string, timeoutMs: number }
    // 返回 Promise<ProbeResult>，**永不 reject**（失败也 resolve 成 ok:false）

    /**
     * 并发探测多个 IP，用 Promise.all；单个失败不影响其他。
     */
    export function probeAll(ips, opts)
    // 返回 Promise<ProbeResult[]>，顺序与入参 ips 一致

实现要点（已验证）：`tls.connect({ host: ip, port: 443, servername, rejectUnauthorized: true })`，
超时用 `setTimeout`；无论成功/失败/超时，都必须 `socket.destroy()` 释放句柄。

---

## 契约 3：`src/lookup.js`（A 负责）

    /**
     * 创建 undici Agent 用的 lookup 钩子。
     * 目标域名：自己 resolve4 → 黑名单过滤 → 选第一个可用的 IPv4 返回。
     * 非目标域名 / 解析失败：原样回退系统解析器，绝不阻断。
     */
    export function createLookup(opts)
    // opts = {
    //   hostnames: string[],           // 需要防护的域名，如 ['opencode.ai']
    //   blacklist,                     // 契约 1 的实例
    //   resolve4?: (h) => Promise<string[]>,   // 可注入，默认 dns.promises.resolve4（测试用）
    //   fallbackLookup?: Function,              // 可注入，默认 dns.lookup（测试用）
    //   forceIps?: string[],           // 测试钩子：非空时忽略真实解析，只用这些 IP
    // }
    // 返回 lookup(hostname, options, callback)

回调规则（**两种形态都要支持**）：

- `options.all === true` → `callback(null, [{ address, family: 4 }])`
- 否则 → `callback(null, address, 4)`
- 必须处理 `options.family`（忽略即可，始终返回 IPv4）

---

## 契约 4：`src/dispatcher.js`（A 负责）

    /**
     * 安装自定义全局 undici dispatcher，让 Node 内置 fetch 走我们的 lookup。
     * 返回句柄；restore() 恢复原 dispatcher。
     */
    export function installDispatcher(opts)
    // opts = { lookup, connectTimeoutMs }
    // 返回 { dispatcher, restore }

实现要点：

- `undici` 必须**动态 import**（`await import('undici')`），因为该函数是 async 场景调用；
- 使用 `new Agent({ connect: { timeout: connectTimeoutMs, lookup } })`；
- 用 `getGlobalDispatcher()` 保存原值，`setGlobalDispatcher(newAgent)` 安装；
- `restore()` 必须幂等，且不得抛错；
- **不要设置 keepAliveTimeout**（决策 D6）。

---

## 契约 5：`src/status.js`（B 负责）

    /**
     * 组装状态快照。纯函数，不持有任何状态。
     */
    export function buildStatus(input)
    // input = {
    //   state, enabled, reason, lastProbeAt, entries, nextRetryAt, extra?
    // }
    // 返回 StatusSnapshot

    StatusSnapshot = {
      state: 'idle' | 'probing' | 'ready' | 'degraded' | 'failed' | 'disabled_by_proxy' | 'error',
      enabled: boolean,
      reason: string | null,
      lastProbeAt: number | null,     // Unix ms
      nextRetryAt: number | null,     // Unix ms
      entries: BlacklistEntry[],
      stats: { ok: number, black: number, total: number }
    }

---

## 契约 6：`src/guard.js`（B 负责）

    /**
     * 编排器：代理检测 → dispatcher 安装 → 异步探测 → 状态维护 → 重试。
     */
    export function createGuard(opts)
    // opts = {
    //   config: { hostname, probeTimeoutMs, enabled, forceIps, retryDelaysMs,
    //             blacklistTtlMs, confirmDelayMs, expiryCheckIntervalMs },  // 已合并默认值
    //   log: (line: string) => void,
    //   deps?: { createLookup, installDispatcher, probeAll, createBlacklist, buildStatus }  // 可注入，便于测试
    // }
    // 返回 {
    //   start(): Promise<void>,
    //   refresh(): Promise<StatusSnapshot>,   // 面板点击：重探并重建黑名单
    //   snapshot(): StatusSnapshot,
    //   dispose(): void
    // }

行为要求：

- `start()` 必须在检测到代理时**不安装 dispatcher**，state 置 `disabled_by_proxy`；
- `start()` 探测必须**异步**（不 await 探测完成），立即返回；
- 全失败时：黑名单不生效（clear），state = `degraded`，按 `retryDelaysMs`（默认 `[60000, 120000]`）重试，第三次失败置 `failed`；
- **失败二次确认**：首轮探测失败的 IP，隔 `confirmDelayMs`（默认 2000）再探一次；连续两次失败才 `markBlack`，第二次成功按 `markOk` 记录第二次耗时（决策 D21/B）；
- **过期补探**：每 `expiryCheckIntervalMs`（默认 30000，unref）检查 `expiredIps()`；**只有存在「过期且 state=black」条目**时才触发重探（ok 条目过期不触发，否则退化为周期探测），探测进行中去重（决策 D21/A）；
- `dispose()` 必须清理定时器并 `restore()` dispatcher；
- 所有异常在内部捕获并 log，**不得抛出**给 DSH。

---

## 契约 7：`src/index.js`（C 负责）

    export const name = 'dsh-opencode-ip-guard'
    export const inject = []
    export async function apply(ctx, rawConfig)

要求：

- 白名单方式读取 `rawConfig`（只接受 `hostname/probeTimeoutMs/enabled/forceIps`）；
- 合并默认值后 `createGuard`，`await guard.start()`（start 内部异步探测，不阻塞）；
- **`apply` 不得返回业务对象**（会让 cordis 报 `Invalid effect`）；
- 用 `ctx.inject(['webServer'], ...)` 注册状态路由：`GET /opencode-ip-guard/status` 与 `POST /opencode-ip-guard/refresh`；
- `ctx.on('dispose', ...)` 调用 `guard.dispose()`；
- 整个 `apply` 用 try/catch 包裹：失败只 log，不抛；
- 若 `webServer` 不可用，插件仍要工作（只是没有面板数据源）。

---

## 契约 8：`src/client.js`（C 负责）

- 形态照抄 `mac-tunnel/src/client.js`（IIFE + `window.__ModuleLoader__.load`）；
- `PLUGIN_ID = 'dsh-opencode-ip-guard'`；
- 挂载点 `conversation.session.header.utilities`；
- 显示：`IP 防护：N 个黑洞`；悬停展开每个 IP 的 state/耗时；「上次探测：X 分钟前」；
- 点击 → `POST /opencode-ip-guard/refresh` → 重新拉取；
- 轮询间隔 60 秒；
- 必须 `exports.inject = ['slots']`；
- 整卡 try/catch，任何异常只 `console.warn`。

---

## 契约 9：`package.json`（D 负责）

    {
      "name": "dsh-opencode-ip-guard",
      "version": "0.1.0",
      "description": "...",
      "type": "module",
      "main": "src/index.js",
      "exports": { ".": "./src/index.js", "./client": "./src/client.js" },
      "files": ["src", "cordis.patch.yml", "README.md", "README.zh.md", "LICENSE"],
      "dependencies": { "undici": "^8.11.2" },
      "engines": { "node": ">=22.19.0" },
      "license": "Apache-2.0",
      "dsh": {
        "bundle": { "patch": "./cordis.patch.yml" },
        "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
      }
    }

## 契约 10：`cordis.patch.yml`（D 负责）

    - insert:
        - id: opencode-ip-guard
          name: 'dsh-opencode-ip-guard'

---

## 禁止事项（所有人）

1. **禁止写入 `D:\deepseek_harness\`**（部署面，只读）；
2. 禁止修改不属于自己责任范围的文件；
3. 禁止引入第三方依赖；
4. 禁止 `git commit`（由 Lead 统一提交）；
5. 禁止修改本契约文件。

## 自测要求

- 每个人写完后，用指定 node 跑自己的测试：

      & "D:\deepseek_harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" --test test/

- 报告里给出「跑了什么、结果如何」；
- 涉及网络的测试（probe）要能在无网络时优雅跳过。