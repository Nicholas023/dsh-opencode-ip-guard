# 专项 B：重试、超时、取消（"已重试模型请求(1/5) · 1s" 与 "已停止"）

> 结论标注规则：【事实】= 代码/实测直接证明；【推断】= 基于事实的合理外推。
> 源码根：`D:\DSH-Files-v2\02-DSH开发\历代dsh源码\_work\v022a2\deepseek-harness-dsh-v0.2.2-alpha.2`（下称 `DSH/`）
> 运行态 pi-ai：`C:\Users\Nicholas023\AppData\Local\Temp\dsh-asar-analyze\piai\dsh\node_modules\@earendil-works\pi-ai`（下称 `PI/`）
> openai SDK：`C:\Users\Nicholas023\AppData\Local\Temp\dsh-asar-analyze\sdk\dsh\node_modules\openai`（v7.19.0）
> undici：`C:\Users\Nicholas023\AppData\Local\Temp\dsh-asar-analyze\sdk\dsh\node_modules\undici`（v8.11.2，行为对齐 Node 内置 7.29.1）

---

## 0. 与 Lead 清单的差异 / 纠错（只列冲突项）

### 纠错 1：SDK 在连接超时时**会**被识别为 timeout，但重试仍被关掉——原因不是"没识别成 timeout"
Lead 清单第 6 条说"连接阶段错误在 client.js catch 里因 !timedOut 直接抛出，不重试"。代码事实是：openai `client.js:793-794` 明确用 `/timed? ?out/i` 匹配 `String(response) + String(response.cause)`：

```js
// openai/client.js:791-794
// undici throws "TypeError: fetch failed" with cause "ConnectTimeoutError: Connect Timeout Error (attempted address: example:443, timeout: 1ms)"
const isTimeout = (0, errors_1.isAbortError)(response) ||
    /timed? ?out/i.test(String(response) + ('cause' in response ? String(response.cause) : ''));
```

`"Connect Timeout Error" / "timeout: 10000ms"` 命中该正则 → `isTimeout = true` → `client.js:820-835` 抛 `APIConnectionTimeoutError()`（默认文案 `Request timed out.`，见 `core/error.js:88-92`）。
**SDK 之所以不重试，是因为 pi-ai 把 SDK 重试显式设为 0**：`PI/dist/api/openai-completions.js:195` `maxRetries: 0`；DSH 侧同义声明在 `DSH/packages/llm/llm-pi-ai/src/adapter.ts:141-142`（`maxRetries: 0`，注释 "one adapter call is one SDK attempt"）。所以单次失败必然上抛到 DSH 的 llm-retry。
【事实】结论不变：连接超时是 **DSH 层** 重试，不是 SDK 层。

### 纠错 2：真机日志里 opencode-go 的重试主因其实是 429/520，不是每次握手超时
见 §5 真机证据：`llm/retry` 事件中 `code` 分布为 `RATE_LIMIT`（429 ttft_admission_refused）最多，其次 `SERVER`(520)、`TRANSPORT`(`"Connection error."`)、`TIMEOUT`(`"pi-ai stream idle timeout after 300000ms"`)。这与"链路间歇性 21s 握手"叠加，而不是互斥。

### 补充 3：空闲复用窗口实测约 3.0s（不是 4s）
见 §4 实测：最后一次使用后 **3040ms** 服务端观测到 TCP CLOSED；间隔 5s 的下一请求建新连接。代码侧默认 `keepAliveTimeout = 4000`，实际回收阈值再减 `keepAliveTimeoutThreshold = 2000`（`undici/lib/dispatcher/client.js:307-309`，`client-h1.js:689-693`），与实测吻合。

---

## 1. 一次 opencode-go 请求的完整时间线（默认参数）

| # | 节点 | 阈值（默认） | 证据 |
|---|---|---|---|
| 1 | DSH 生成 LLM 请求 → pi-ai `streamSimple` | — | `adapter.ts:416-425` |
| 2 | 构造 pi-ai OpenAI 客户端（**每次 stream 都 new**） | — | `PI/dist/api/openai-completions.js:531,557-563`；调用点 `adapter.ts:416` |
| 3 | idleWatchdog 启动（只在 iterator `next()` 未完成时计时） | `streamIdleTimeoutMs = 300000`（5 分钟） | `DSH/packages/llm/llm-pi-ai/src/config.ts:47,344`；`adapter.ts:390-391`；`DSH/packages/util/timeout/src/index.ts:154-187` |
| 4 | SDK 请求级超时 | `timeoutMs` **未配置=undefined**（SDK 默认 10 分钟） | `config.ts:342`（`z.natural()` 无 default）；`openai-completions.js:194` |
| 5 | **undici TCP connect 超时** | **10000ms**（`buildConnector` 默认，Node 内置 undici 同值） | `undici/lib/core/connect.js:69` `timeout = timeout == null ? 10e3 : timeout`；超时即 `destroy(socket, ConnectTimeoutError)`（`lib/core/util.js:886`） |
| 6 | 失败上抛：pi-ai 把 Error 压成 message（丢 cause） | — | `PI/dist/api/openai-completions.js:501-511`；`utils/error-body.js:111-118`（只取 `error.message`） |
| 7 | DSH 归类：`Request timed out.`→TIMEOUT；`fetch failed`/`Connection error.`→TRANSPORT | 两者都在默认 `retryableCodes` | `DSH/packages/llm/llm-pi-ai/src/stream.ts:42-68`；`packages/llm/llm/src/retry-policy.ts:18-24` |
| 8 | `agent/request-error` waterfall → llm-retry 决策 | `maxRetries=5`，`initialDelayMs=500`，`maxDelayMs=10000`，`jitter=0.1`，`mode=normal` | `retry-policy.ts:14-17,149-160`；`DSH/packages/llm/llm-retry/src/index.ts:212-237` |
| 9 | 退避等待（可被 abort 打断） | `delay = min(500*2^(retry-1),10000)*(1-0.1+0.2*rand)` | `llm-retry/src/index.ts:59-64,83-96,185` |
| 10 | 重试 = 回到 step 循环顶部，**整条请求重发** | — | `DSH/packages/core/agent-loop/src/agent.ts:548-563`（`continue`） |
| 11 | 重试用尽 → 抛 LlmError → `turn/end` `{kind:'error'}` | — | `agent.ts:560-562,412-422` |
| 12 | 用户点停止 → `cancel({kind:'user'})` → abort → `turn/end` `{kind:'aborted',reason:{kind:'user'}}` → UI "已停止" | — | `agent.ts:191-197,402-408,422`；`ui-chat/src/client/chat/TurnProcessNodeView.tsx:21-31`；locale `message.stopped: '已停止'`（`ui-chat/src/client/locale.ts:161`） |

**结论：DSH 代码里不存在"10s 或 30s 的请求总超时/Watchdog 会把 21s 握手掐断"这类逻辑。**
- 空闲看门狗是 300s（5 分钟），且是"多久没数据"而非总时长；
- SDK timeout 未配置（10 分钟）；
- 真正把 21s 握手掐断的是 **undici 的 TCP connect 超时 10s**（第 5 行），错误文本经 pi-ai 变成 `Request timed out.` / `fetch failed`，被归为 TIMEOUT/TRANSPORT 后进入重试。
- 【推断】用户看到的"握手握不上去直接掐断"= 第 5 行：attempt 在第 ~10.07s 被 undici `ConnectTimeoutError` 掐断，随即出现第 9 行的退避计数。
- "已停止"= 第 12 行用户主动取消（与 Lead 收到的澄清一致），不是重试耗尽。

---

## 2. "已重试模型请求(1/5) · 1s" 里 1s 到底是什么

**1s 是"下一次重试的已排定退避延迟（向上取整到秒）"，不是累计耗时、也不是请求耗时。**

代码（`DSH/packages/client/ui-chat/src/client/chat/MessageItem.tsx`）：
```tsx
// 42-44
function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}
// 71
const scheduledSeconds = retrySeconds(node.delayMs)
// 99-106
const label = active ? t('message.retry.active') : node.retryState === 'cancelled' ? ... : 'started'
const seconds = active ? remainingSeconds : scheduledSeconds
// 111-114  文案 "已重试模型请求（{retry}/{maximum}） · {seconds}s"
```
- `node.delayMs` 是持久化事件 `llm/retry` 的 `data.delayMs`（`llm-retry/src/index.ts:160-184` 的 `eventData.delayMs`）。
- 默认首次退避 = `500ms * (1±0.1)` → `ceil(0.45~0.55) = 1` → 显示 `1s`。
- 第 2~5 次理论显示：`1s, 2s, 3s, 4s, 8s`（退避 1s/2s/4s/8s，抖动后 ceil）。

**真机日志直接印证**（`C:\Users\Nicholas023\.dsh\sessions\...\session.v4.jsonl.zstd`，已解帧）：
```json
{"type":"llm/retry","data":{"provider":"opencode-go","mode":"normal",
 "policyKey":"[\"normal\",5,[\"EMPTY_RESPONSE\",\"RATE_LIMIT\",\"SERVER\",\"TIMEOUT\",\"TRANSPORT\"],500,10000,0.1]",
 "retry":1,"maxRetries":5,"delayMs":520.2848438778112,
 "failure":{"message":"429: ... [ttft_admission_refused] ...","code":"RATE_LIMIT"}}}
{"type":"llm/retry-started","data":{"retry":1}}
```
→ `delayMs=520.28` → `ceil(0.52)=1` → 界面显示 `已重试模型请求（1/5） · 1s`。**1s 是延迟，不是耗时。**

补充：`5` 是**硬上限**（`maxRetries` 默认 5，`retry-policy.ts:14`；判定 `llm-retry/src/index.ts:220` `previousRetry >= policy.maxRetries` 时不再重试），且 `/5` 来自事件里的 `maxRetries`（UI `maximum`）。

---

## 3. 重试是否让总耗时放大？（a 项：总耗时算式）

**是。每次重试都是"一整次新的模型请求"**：`agent.ts:548-563` 的 `continue` 回到 step 循环顶部 → `preparedCall.stream(request)` → pi-ai `stream()` → `createClient()` **新建 OpenAI 实例**（`openai-completions.js:531,557`）→ 新 fetch 请求。是否新 TCP 连接由 §4 的池化/销毁行为决定。

**最坏情况（每次都卡在 10s connect 超时）总耗时：**
```
6 次尝试 × ~10.07s(undici connectTimeout=10000 + 握手开销)
+ 5 次退避 0.5+1+2+4+8 = 15.5s（× 0.9~1.1 抖动 → 13.95~17.05s）
≈ 60.4 + 15.5 ≈ 74~78s 才最终失败
```
（代码依据：`undici/lib/core/connect.js:69`；`retry-policy.ts:14-17`；`llm-retry/index.ts:59-64,220`）

若中途用户取消：`llm-retry/src/index.ts:83-96` 的 `cancellableDelay` 立刻返回 `false` → `backoff()` 返回 undefined（`index.ts:185`）→ 不重试；且 `ABORTED` 不在 `retryableCodes` 中（`retry-policy.ts:18-24`），即使已进入重试也不会对"用户取消"再重试。→ 界面停在 "已停止"。

**关键放大效应【事实+推断】**：
- 若失败是 429/520（连接仍活着、连接回池），退避 500ms 的重试**可能复用**同一条 TCP（实测空闲 <3s 会复用）；
- 但退避第 4/5 次已到 3.87s / 7.34s（真机日志实测值），**超过实测 ~3.0s 的空闲回收阈值**，连接必然被关 → 重试也要**重新握手**；
- 若失败是 connect 超时/中途 abort，socket 已被销毁（§4）→ 每次重试都**必须重新握手**，在 21s 链路上每次重试都再赌一次 10s 内握手成功。这就是"越等越慢、越重试越糟"的负循环。

---

## 4. 用户取消(abort) 是否会销毁底层连接？——会（代码 + 实测）

### 代码链（abort 一路到达 fetch → undici 销毁 socket）
1. DSH 用户取消：`agent.cancel({kind:'user'})` → `this.phase.abort.abort(cause)`（`agent.ts:191-197`）。
2. adapter 把取消信号融合成 watchdog signal 交给 pi-ai：`adapter.ts:386-391`
   ```ts
   const consumer = new AbortController()
   const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
   using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')
   ```
3. 作为 `signal` 传给 pi-ai：`adapter.ts:421` `signal: watchdog.signal`。
4. pi-ai 原样放进 SDK 请求：`PI/dist/api/openai-completions.js:192-196` `requestOptions = { ...(options?.signal ? { signal: options.signal } : {}), ... maxRetries: 0 }`。
5. openai SDK 把它当 fetch 的 signal：`openai/client.js:992-1001`（`fetchWithTimeout`：`const { signal } = init`；`signal.addEventListener(...abort...)`；`fetchOptions = { signal: controller.signal, ... }`），`client.js:1012` 调用全局 fetch。
6. undici 对已发出/在建连请求 abort → 销毁该 socket，连接**不能**回池复用。【事实：实测见下；代码：`undici/lib/core/util.js:886` 连接期定时器到期即 `destroy(socket, ConnectTimeoutError)`，abort 走同一条 destroy 路径】

另外 `adapter.ts:437-445,454-455` 显示：DSH **每次** stream 结束（正常/异常/提前 yield 中断）都会在 finally 执行 `consumer.abort('pi-ai stream consumer stopped')`。正常读完时对已结算请求无副作用；但**流被提前中断（用户停止、看门狗超时、yield 被 break）时，它就是"销毁当前连接"的那次 abort**。

### 实测（用运行态同一套 Node/undici：Node 24.21.0 / undici 7.29.1，本地 HTTP 服务端记录 remotePort）
脚本：`C:\Users\Nicholas023\AppData\Local\Temp\dsh-probe\probe2.mjs`
```
--- C: GET, wait 5000ms, GET
[server] NEW TCP CONNECTION remotePort=55070 at 17ms
[server] req /e remotePort=55070 at 22ms
[server] TCP CLOSED remotePort=55070 at 3040ms          <- 空闲 ~3.0s 被回收
[server] NEW TCP CONNECTION remotePort=55078 at 5049ms  <- 5s 后请求重新握手
[server] req /f remotePort=55078 at 5050ms
--- D: stream, read 1 chunk, abort, wait 300ms, GET
[server] NEW TCP CONNECTION remotePort=55079 at 5052ms
[server] req /stream remotePort=55079 at 5052ms
[server] TCP CLOSED remotePort=55079 at 5118ms          <- abort 后 66ms 连接被销毁
[server] NEW TCP CONNECTION remotePort=55080 at 5119ms
```
**结论：用户取消（或任何 abort）确实销毁当前 TCP 连接；下一次请求必须重新握手。** 在 21s 链路上，这意味着"取消一次 = 下次再付 21s"。

---

## 5. 真机证据：opencode-go 确实在走这条重试链

来源：解压 `C:\Users\Nicholas023\.dsh\sessions\*\*\session.v4.jsonl.zstd`（多帧 zstd，解帧脚本 `dsh-probe/probe9.mjs`），共 6 个会话含 `llm/retry` 事件（258 个会话中）。代表性记录：

| 时间(本地) | provider | retry/max | delayMs | failure.code | failure.message |
|---|---|---|---|---|---|
| 2026-10-28 | opencode-go | 1/5 | 520.28 | RATE_LIMIT | 429 `[ttft_admission_refused] the cell is at capacity` |
| 同上 | opencode-go | 2/5 | 1048.89 | RATE_LIMIT | 同上 |
| 同上 | opencode-go | 3/5 | 2059.74 | RATE_LIMIT | 同上 |
| 同上 | opencode-go | 4/5 | 3868.31 | RATE_LIMIT | 同上 |
| 同上 | opencode-go | 5/5 | 7340.29 | RATE_LIMIT | 同上 |
| 2026-10-28 | opencode-go | 1/5 | 484.02 | **TRANSPORT** | **`Connection error.`** |
| 2026-10-28 | opencode-go | 1/5 | 511.69 | SERVER | 520 `Upstream response was not valid JSON` |
| 2026-10-28 | opencode-go | 1/5 | 480.84 | TIMEOUT | `pi-ai stream idle timeout after 300000ms` |

- `policyKey` 全部为 `["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]`，**直接证明默认策略与默认阈值**。
- `"Connection error."` 是 openai SDK `APIConnectionError` 的默认文案（`openai/core/error.js:78-85`；`client.js:840-843` `getConnectionErrorMessage`），即"连不上/连接断了"这一类，**不是** HTTP 状态错误。
- 这些记录证明：重试链、退避值、UI 的 `(n/5) · Xs` 显示全部来自 `llm-retry` + `llm/retry` 事件，与界面现象一一对应。

---

## 6. 回答必查清单

1. **重试次数上限**：`maxRetries=5`（默认，硬上限；不足时 `llm-retry/index.ts:220` 直接放弃）。界面 `(1/5)` 的 5 即该值。
2. **退避策略**：指数 `500ms*2^(retry-1)`，上限 10s，对称抖动 ±10%，可被 abort 立即打断（`index.ts:59-64,83-96`）。
3. **每次重试是否复用底层连接**：是否复用不由 DSH/pi-ai 决定，而由 undici 全局连接池决定；实测池化空闲 ~3.0s 即关，abort/connect 超时立即销毁 → 绝大多数重试都重新握手（§3/§4）。
4. **判定重试的错误类型**：默认 `EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT`（`retry-policy.ts:18-24`）；`ABORTED`、`AUTH`、`INVALID_REQUEST`、`PI_AI_ERROR` 不重试。
5. **中断语义**：用户 abort → `agent.cancel` → `turn/end {kind:'aborted',reason:{kind:'user'}}` → UI "已停止"；不会被判定为可重试错误。
6. **idleWatchdog 是"多久没数据"**（只在 `next()` 未完成时计时，`timeout/src/index.ts:154-187`），握手期间"没有任何响应字节"**确实会计入空闲时间**，但阈值 300s，远大于 21s → **不会误判**；真正掐断握手的是 undici 10s connect 超时。
7. **timeoutMs / websocketConnectTimeoutMs 默认值**：`timeoutMs` 未配置=undefined（SDK 默认 10 分钟），`websocketConnectTimeoutMs` 未配置（仅 websocket transport 相关）；用户 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 opencode-go 段只有 `models` + `apiKeyEnv`，两者都未设。
8. **5 次重试 × 每次 21s 握手是否在总超时内**：DSH 无总超时；最坏 ~60.4s 尝试 + ~15.5s 退避 ≈ 74~78s 才失败（§3）。但每次握手会先在 10.07s 被掐断，因此"5 次 ×21s"不会真的发生——发生的是"6 次 ×10s 全失败"。

---

## 7. 对修复方向的含义（供 Lead 汇总，非本专项结论）

- 只做 keep-alive 不够：池化空闲 ~3s 就会被关，且 abort/超时都会毁连接；必须显式使用自建 `undici.Agent({ keepAliveTimeout, connectTimeout })` 并通过 pi-ai 的 `fetch` 选项注入（DSH 目前不传 fetch，`adapter.ts:416-425` 无 fetch 字段 → SDK 用 `globalThis.fetch`，`openai/internal/shims.js:14-18`）。
- 必须同时把 connect 超时放宽到 >21s（例如 60s），否则 21s 握手永远在 10s 被掐。
- keep-alive 复用只能省掉"握手"，无法救"每条连接都 21s"的场景；配 connect 超时放宽 + 池化常驻才成立。
- 重试策略在跨境慢链路上是放大器（每次失败重付握手），修复前建议把 maxRetries 调小或把 initialDelay 调大【推断/建议】。
