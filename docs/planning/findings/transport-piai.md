# 传输层连接生命周期：DSH → opencode.ai 到底有没有复用 TCP/TLS？

> 专项任务 A 产出（队友 transport-piai）
> 证据基线：DSH 源码 v0.2.2-alpha.2（只读）、运行态 app.asar 提取的 @earendil-works/pi-ai@1.1.0、openai@7.19.0、undici@8.11.2
> 采集时间：2026-10-29

---

## 0. 一句话结论

**正常情况下（一次请求完整跑到 [DONE]、响应体在协议层结束）连接是会被复用的；"每次 stream 都 new OpenAI()"并不是原因——连接池挂在全局 undici dispatcher 上，不在 OpenAI client 上。真正毁掉连接的是三件事：**

1. **undici 默认 connectTimeout = 10 秒**（undici/lib/core/connect.js:69），比跨境 SYN 重传成功所需的 21 秒短一半 → 每次尝试都在 10s 被掐断 → DSH 重试（最多 5 次）→ 每次重试都重新握手，永远等不到那一次 21s 的成功。
2. **abort/取消发生在响应体结束之前时，undici 直接 connection.destroy()**（undici/lib/web/fetch/index.js:150）→ socket 被销毁、不进池 → 下一次请求必然重新 TCP+TLS。
3. **undici 默认 keepAliveTimeout = 4000ms**（undici/lib/dispatcher/client.js:307）→ 命中之后再空闲超过 4 秒，池里的连接就被 idle 超时销毁（client-h1.js:857-860）→ 下一轮对话仍然重新握手。

**即使用户不取消，第 1 条也足以造成"每次新连接"；即使用户取消，第 2 条保证"取消后下一次更慢"——这就是负循环。**

---

## 1. 端到端调用链（谁在发请求）

| 层 | 位置 | 行为 |
|---|---|---|
| DSH 路由 | 模型 deepseek-v4.1-flash 属于 pi-ai 的 opencode-go / api: "openai-completions" / baseUrl: "https://opencode.ai/zen/go/v1" | 走 OpenAI 兼容 SSE |
| DSH adapter | packages/llm/llm-pi-ai/src/adapter.ts:416-425 | 调 models.streamSimple(model, context, {...profileOptions, signal: watchdog.signal, headers}) |
| profileOptions | packages/llm/llm-pi-ai/src/adapter.ts:127-144 | **只传** apiKey/reasoning/thinkingBudgets/cacheRetention/transport/timeoutMs/websocketConnectTimeoutMs/maxRetries:0，**不传 fetch、不传 dispatcher** |
| pi-ai | pi-ai/dist/api/openai-completions.js:186 | createClient(model, ctx, apiKey, options?.headers, options?.fetch, ...)；options.fetch 恒为 undefined |
| pi-ai | pi-ai/dist/api/openai-completions.js:557-563 | **每次 stream 都 new OpenAI({apiKey, baseURL, dangerouslyAllowBrowser:true, fetch, defaultHeaders})** |
| openai SDK | openai/client.js:243 | this.fetch = options.fetch ?? Shims.getDefaultFetch() → **全局 fetch** |
| openai SDK shims | openai/internal/shims.js:14-19 | getDefaultFetch() = 若 typeof fetch !== 'undefined' 则 return fetch |
| Node fetch | Node 24 内置 undici（globalThis[Symbol.for('undici.globalDispatcher.1/2')]） | 全局 dispatcher 持有连接池 |
| DSH 代理层 | packages/util/http-proxy/src/install.ts:143-223 + 启动点 apps/cli/src/profile-boot.ts:276 | 若环境里有 HTTP(S)_PROXY/ALL_PROXY：**启动时一次性** setGlobalDispatcher(new Agent({factory}))，进程级单例 |
| 池参数 | 无人显式传 keep-alive / connectTimeout | → 全部是 undici 默认值（4s idle、10s connect） |

> 说明：opencode-go 只提供 openai-completions / anthropic-messages / openai-responses 三种 API，**没有 websocket 路径**；transport 选项在 pi-ai 里只被 api/openai-codex-responses.js:184-203 消费，openai-completions 完全忽略它（该文件全文无 transport 引用）。已部署 profile（~/.dsh/profiles/desktop/cordis.patch.yml:83 起）也没有设置 transport/timeoutMs/streamIdleTimeoutMs，全部走默认。

---

## 2. 逐步结论表：建连 / 复用 / 销毁

| 步骤 | 代码证据 | 行为（事实） |
|---|---|---|
| ① 每次 stream 新建 SDK 客户端 | pi-ai/dist/api/openai-completions.js:557 return new OpenAI({...}) | **事实**：确实每次都 new。**但**这不产生新连接池：fetch 为 undefined → 用全局 fetch（openai/client.js:243），池属于全局 dispatcher。对比：pi-ai/dist/api/anthropic-messages.js:796-805 有 federation client 缓存，openai 路径没有——同样**与 socket 复用无关**。 |
| ② 是否有"每请求新建 Agent/连接池" | pi-ai/dist/utils/node-http-proxy.js 全文 | **事实**：pi-ai 里只有 Bedrock 用 new HttpProxyAgent/new HttpsProxyAgent（dist/api/bedrock-converse-stream.js:107-108），opencode-go 不走 Bedrock。openai-completions 路径上**没有任何** buildFetch/withProxy/resolveFetch。 |
| ③ 真正的连接池在哪 | packages/util/http-proxy/src/install.ts:143-157（new Agent({factory})）、:174-223（setGlobalDispatcher(agent)，进程级单例，:216-222 才 close） | **事实**：有代理时是**进程级单例** Agent（不是每请求新建），factory 按 origin 产出 new Pool(origin, passed) 或 new ProxyAgent({...passed, uri})；**没有传任何 keepAlive 选项，即 undici 默认**。无代理时（policy.source === 'none'，:176-187）**根本不替换 dispatcher**，用 Node 默认 Agent，同样是默认 4s/10s。 |
| ④ 连接能否挂回池 | undici/lib/dispatcher/client-h1.js:655-707（shouldKeepAlive + kKeepAliveTimeoutValue）、:771-837（onMessageComplete → setImmediate(client[kResume])） | **事实**：响应在协议层完整结束（llhttp on_message_complete）且服务端未要求 close → socket 放回池，可被下个请求复用。 |
| ⑤ 复用的时间窗口 | undici/lib/dispatcher/client.js:307-309（4e3 / 600e3 / 2e3 默认）、client-h1.js:857-860（TIMEOUT_KEEP_ALIVE → util.destroy(socket, 'socket idle timeout')） | **事实**：**空闲 4 秒连接就被销毁**。工具调用/用户思考间隔通常 >4s → 每轮都重新握手。 |
| ⑥ 建连超时 | undici/lib/core/connect.js:69 timeout = timeout == null ? 10e3 : timeout | **事实**：TCP+（TLS 在 connect 内）**10 秒超时**。opencode.ai 的跨境 SYN 要 21.2s 才能握上 → **DSH 永远先被 10s 掐断**。 |
| ⑦ 请求级超时 | undici/lib/dispatcher/client.js:316-317（headers/body 300e3）；OpenAI SDK client.js:1307 DEFAULT_TIMEOUT = 600000；client.js:991-1025 fetchWithTimeout 的 setTimeout(abort, ms) 在响应头返回后 clearTimeout（:1022-1024） | **事实**：SDK 的 timeout 只管到响应头；流式 body 不受它限制。DSH 侧另有 idle watchdog：adapter.ts:390-391（默认 DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000，config.ts:47）。 |
| ⑧ 取消/超时如何处置连接 | openai/client.js:993-996（abort = () => controller.abort()、setTimeout(abort, ms)）、:1228-1232（_makeAbort）、internal/utils/abort.js:57-70（响应返回后仍把 abort 回调挂在 response body 上）；undici/lib/web/fetch/index.js:118-152（Fetch.abort()/terminate() → **this.connection?.destroy(error)**） | **事实**：**只要 abort 发生在响应体协议级结束之前 → socket 被 destroy，不进池。** |
| ⑨ abort 何时无害 | undici/lib/web/fetch/index.js:2381-2389 onResponseEnd(){ … controller.off('terminated', this.abort); controller.ended = true; this.body?.push(null) } | **事实**：服务端已经把响应体发完（llhttp message-complete）后，abort 链路已被摘除，此时 abort 不会杀连接。**前提是服务端真的结束了响应体**；若服务端 [DONE] 后保持 SSE 响应不结束，则 abort 仍然 destroy。 |
| ⑩ SSE 正常收尾是否 abort | openai/core/streaming.js:80-156：fromSSEResponse 收到 [DONE] 置 receivedCompletionSentinel = true 后 break；finally 里 if (!done) controller.abort() | **事实**：走完整 [DONE] 的正常路径**不会** abort（done = true）；只有中途 break/异常/取消才 abort。 |
| ⑪ DSH 自己在 finally 里主动 abort | packages/llm/llm-pi-ai/src/adapter.ts:437-445（if (!exhausted) consumer.abort(...)）、:454-456（finally **无条件** consumer.abort('pi-ai stream consumer stopped')） | **事实**：每次 stream 结束都会 abort 一个 AbortSignal.any([options.signal, consumer.signal])（:386-389）派生信号，并作为 signal: watchdog.signal 传给 pi-ai（:421）。**若此刻响应体在协议层已结束 → 无害；否则 → destroy socket。** |

---

## 3. 受控实验（本机可复现，非纯推理）

实验脚本（临时目录，可重复运行，不触碰部署面）：
- C:\Users\Nicholas023\AppData\Local\Temp\dsh-asar-analyze\dispatcher-interop-test.cjs
- C:\Users\Nicholas023\AppData\Local\Temp\dsh-asar-analyze\conn-reuse-test2.cjs
- C:\Users\Nicholas023\AppData\Local\Temp\dsh-asar-analyze\conn-reuse-test4.cjs

运行环境：部署面同款 node.exe（v24.21.0）+ asar 内 undici@8.11.2，服务端用本地回环 HTTP server 统计**实际新建 TCP 连接数**（connection 事件）与客户端端口。

### 实验一：npm undici 的 setGlobalDispatcher 是否接管 Node 内置 fetch

~~~
node v24.21.0
fetch rejected: fetch failed | cause: DSH_CUSTOM_DISPATCHER_WAS_USED | hits: 1
~~~

**结论（事实）**：DSH 的 installProxyFromEnvironment 装的 dispatcher **确实接管全局 fetch**（Node 内置 undici 通过 Symbol.for('undici.globalDispatcher.1') 互通；npm undici 8 同时写 .1/.2 两个符号，见 undici/lib/global.js:5-6,18-55）。所以池参数由 DSH 安装的 Agent 决定。

### 实验二：3 次顺序请求，实际新建了几条 TCP 连接？（每组独立 server + 独立默认 Agent）

| 用例 | 3 次请求新建连接数 |
|---|---|
| 读完 EOF（对照组） | **1**（完全复用） |
| 读到 [DONE] 就停读（**openai SDK 的 fromSSEResponse 行为**） | **1** |
| 读到 [DONE] 后 abort（**模拟 DSH adapter finally**） | **1** |
| 读完 EOF，请求间隔 1s | **1** |
| 读完 EOF，请求间隔 5s（> 默认 4s idle） | **3**（每次都新建） |

**结论（事实）**：
- 正常收尾路径**连接复用没问题**，SDK 的"读到 [DONE] 就停读"也不会破坏复用；
- 但**空闲 5 秒 = 3 次全新连接**，这就是"多轮对话每次都要重新握手"的直接原因。

### 实验三/四：响应未结束时 abort，连接会发生什么？

~~~
--- 步骤1：正常请求，间隔 200ms ---
  SRV /ok -> 连接#1(port 55119)
  SRV /ok -> 连接#1(port 55119)        <- 复用同一条
--- 步骤2：发起永不结束的流，读首块后 abort ---
  SRV /hold -> 连接#1(port 55119)
  CONN 连接#1 被关闭                    <- abort 后 4ms 被销毁
--- 步骤3：abort 之后再请求一次 ---
  SRV /ok -> 连接#2(port 55123)         <- 必须重新建连
~~~

**结论（事实）**：**abort 在响应体结束前发生 → 该连接被 destroy → 下一次请求从零开始 TCP+TLS。** 与 undici/lib/web/fetch/index.js:150 的 connection?.destroy(error) 完全一致。

---

## 4. 明确回答任务问题

### Q1：正常情况下同一条 opencode 连接会不会被复用？

**会**，前提三个同时成立：
1. 本次响应在协议层**完整结束**（服务端把 SSE 响应体发完 / 正常 EOF）；
2. 两次请求之间的空闲时间 **< 4000ms**（undici 默认 keepAliveTimeout）；
3. 没有中途 abort（用户停止、连接超时、idle 超时都会 abort）。

满足时：**复用成功，握手只付一次**；不满足时：**新 TCP+TLS**。

### Q2：什么条件下连接被销毁重建？

| 触发条件 | 代码位置 | 结果 |
|---|---|---|
| 空闲 > 4s（默认） | undici/lib/dispatcher/client.js:307 + client-h1.js:857-860 | socket idle 超时 → destroy |
| 建连超过 10s | undici/lib/core/connect.js:69 | UND_ERR_CONNECT_TIMEOUT → fetch 失败 → DSH 重试（每次全新握手） |
| 响应结束前 abort（用户取消 / idle watchdog / SDK timeout 到点） | undici/lib/web/fetch/index.js:118-152；SDK 侧 openai/client.js:993-996,1228-1232；DSH 侧 adapter.ts:386-389,421,454-456 | connection.destroy() → socket 不复用 |
| 服务端 Connection: close / 半关闭 | client-h1.js:655-707,817-819 | destroy，属服务端行为 |
| headers 超时 300s / body 超时 300s | undici/lib/dispatcher/client.js:316-317 | destroy（本次场景不会先命中） |

### Q3（Lead 追加）：取消时 undici/openai SDK 如何处置连接？

- OpenAI SDK：fetchWithTimeout（client.js:991-1025）把调用方 signal 与内部 controller 组合，响应头返回后**不解除** abort 关联（client.js:1013-1015 → internal/utils/abort.js:57-70 的 retainRequestAbortCallback 把 abort 回调挂在 response body 上），所以**流式读取期间**调用方一 abort，内部 controller.abort() 立刻执行。
- undici：Fetch.abort() → this.connection?.destroy(error)（lib/web/fetch/index.js:150）→ 对应 dispatch 里的 this.abort = connection.abort = (reason) => controller.abort(reason)（:2251-2258）→ Client 销毁 socket。**不是"优雅归还连接池"，是直接 destroy。**
- 唯一例外：onResponseEnd（:2381-2389）已发生（响应体协议级结束）后，abort 关联被摘除，abort 无害——实验二/三已验证。

### Q4（Lead 追加）：DSH packages/util/http-proxy 会不会替换全局 fetch/dispatcher？Agent 是单例还是每请求？

- **会替换全局 dispatcher，但不替换 global fetch 函数**：installGlobalProxy 里 setGlobalDispatcher(agent)（install.ts:213-215），Node 内置 fetch 走这个 dispatcher（实验一已证明）。
- **Agent 是进程级单例**：只在启动时 apps/cli/src/profile-boot.ts:276 创建一次，install.ts:216-222 的 disposer 里才 close()。**不是每请求新建**。
- **keepAlive 配置：没有配置**。createPolicyDispatcher（install.ts:143-157）只传 factory，Pool/ProxyAgent 直接吃 passed 选项，**没有 keepAliveTimeout/connections/connectTimeout** → 全部 undici 默认（4s idle、10s connect）。
- 无代理时（policy.source === 'none'，install.ts:176-187）连 dispatcher 都不替换，用的是 Node 内置默认 Agent，默认值同样是 4s/10s。
- proxyRouteFor（install.ts:62-68）只是"把已装的 dispatcher 交回给调用方"，供 web-fetch-http 这类需要显式 dispatcher 的调用点使用；它**不创建新 Agent**。

---

## 5. 所有会导致"每次请求新 TCP+TLS"的代码路径（清单）

| # | 路径 | 证据 | 类型 |
|---|---|---|---|
| P1 | **建连超时 10s < 跨境 21s 握手** → 每次尝试被掐断 → 重试 → 再掐断 | undici/lib/core/connect.js:69；DSH 重试：packages/llm/llm/src/retry-policy.ts:14-24（默认 maxRetries=5，retryableCodes 含 TIMEOUT/TRANSPORT）、packages/llm/llm-retry/src/index.ts:212-237 | **主因（推断，需线上日志确认）** |
| P2 | **空闲 4s 即销毁池连接** | undici/lib/dispatcher/client.js:307；client-h1.js:857-860 | 主因（事实，实验二） |
| P3 | **响应体结束前 abort → socket destroy** | undici/lib/web/fetch/index.js:118-152,2251-2258；openai/client.js:993-996,1228-1232；openai/internal/utils/abort.js:57-70 | 主因（事实，实验三/四） |
| P4 | DSH adapter 每次 stream 结束 consumer.abort() | packages/llm/llm-pi-ai/src/adapter.ts:386-389,437-445,454-456 | 条件性（响应未在协议层结束时会毁连接） |
| P5 | DSH 无任何 keepAlive/connectTimeout 调参点 | adapter.ts:127-144（无 fetch/dispatcher）、http-proxy/src/install.ts:143-157（无 keepAlive 选项） | 结构性 |
| P6 | 每次 new OpenAI() | pi-ai/dist/api/openai-completions.js:557 | **已排除**（不影响连接池） |
| P7 | 每请求新建 Http(s)ProxyAgent | pi-ai/dist/api/bedrock-converse-stream.js:107-108 | **已排除**（opencode-go 不走 Bedrock） |
| P8 | 每请求 new ProxyAgent 造成新池 | http-proxy/src/install.ts:150 在 factory 内，按 origin 缓存 | **已排除**（Pool/Agent 按 origin 复用） |

> 线上核实方法（不改任何文件）：netstat -ano | findstr :443 对比刚发请求前后的客户端端口，或开 NODE_DEBUG=undici。若要区分 P1 与 P3，看错误文本：fetch failed + cause ConnectTimeoutError 即 P1；用户点停止/超时后立刻出现新连接即 P3。

---

## 6. 负循环（用户看到的"握手握不上去就直接掐断 + 已重试模型请求(1/5) + 已停止"）

~~~
t=0     发请求 -> SYN（跨境丢包）
t≈10s   undici connectTimeout 到点 -> abort -> socket destroy，报 UND_ERR_CONNECT_TIMEOUT
        异常经 openai SDK -> pi-ai -> DSH 分类：stream.ts:51/59-66 -> TIMEOUT/TRANSPORT（可重试）
t≈10.5s llm-retry 第 1 次重试（退避 500ms*2^(n-1)*jitter，retry-policy.ts:15-17）
        界面显示「已重试模型请求(1/5) · 1s」 <- 与 maxRetries=5、initialDelayMs=500 完全吻合
t≈20s   第 2 次尝试同样在 10s 被掐断……
t≈21s   ——如果让这一次跑完，SYN 重传本来会成功；但它已经被掐断
用户等不及点"停止" -> 再 abort -> 连接再次 destroy
~~~

**关键点：21 秒的成功门槛 > 10 秒的失败门槛，所以系统在概率上永远等不到成功那一次。** 同时即便某次成功，只要下一轮间隔 >4 秒，池里的连接也已被 idle 超时销毁，仍然要从头握手。这就是"复用后 1.4~2.6 秒"在 DSH 里看不到的原因。

---

## 7. 对「dshapi 长连接插件」的直接含义（可操作项，按收益排序）

1. **把 connectTimeout 从 10s 提到 > 21s（建议 30s）**——这是唯一能打破"永远在 10s 被掐断"的改动。实现方式：给 OpenAI SDK 传 fetch+自定义 dispatcher，或安装一个替换全局 dispatcher 的插件，例如 new undici.Agent({ connect: { timeout: 30_000 }, keepAliveTimeout: 120_000, keepAliveMaxTimeout: 600_000, connections: 4 })。
2. **把 keepAliveTimeout 从 4s 提到 >=120s（并设 keepAliveMaxTimeout）**——插件生效后，多轮对话/工具调用之间才不会反复握手。
3. **必须保证 pi-ai 的分支真的用上了这个 dispatcher**：pi-ai 只在 options.fetch 存在时才传给 SDK（openai-completions.js:186,557-563），而 DSH adapter 不传 fetch（adapter.ts:127-144）。因此插件只有两条合法注入路径（二选一）：
   - (a) 插件层 setGlobalDispatcher() 覆盖全局（对 openai SDK 透明，改动最小、不碰 pi-ai 代码）；
   - (b) 给 DSH adapter 加 fetch 透传（需要改 llm-pi-ai，成本更高）。
4. **慎用 abort 作为"止损"手段**：abort 一定会销毁 socket（P3）。若要保留连接，宁可让请求自然失败/完成也不要中途 abort；或者接受"取消即断"，但靠 (1)(2) 把"下一轮重新握手"的代价降下来。
5. **不要花力气去修"每次 new OpenAI()"**——它不是原因（P6 已排除）。同理不要动 Bedrock 的 HttpProxyAgent 路径（P7）。

---

## 8. 事实 vs 推断

**代码/实验直接证明（事实）**
- openai-completions 路径 fetch 恒为 undefined → 全局 fetch（openai-completions.js:186,557-563；openai/client.js:243；openai/internal/shims.js:14-19）。
- 连接池在全局 undici dispatcher，DSH 的 http-proxy 装的是进程级单例 Agent，且无 keepAlive 调参（http-proxy/src/install.ts:143-157,174-223；apps/cli/src/profile-boot.ts:276）。
- npm undici 的 setGlobalDispatcher 确实接管 Node 24 内置 fetch（实验一）。
- 正常收尾可复用；空闲 >=5s 必新建；响应未结束时 abort 必 destroy（实验二/三/四）。
- undici 默认 keepAliveTimeout=4s、connectTimeout=10s、headers/bodyTimeout=300s（client.js:307-309,316-317；core/connect.js:69）。
- transport/websocketConnectTimeoutMs 对 opencode-go 无效（仅 openai-codex-responses.js 使用）。
- DSH 重试默认 5 次、初始 500ms 退避、可重试码含 TIMEOUT/TRANSPORT（retry-policy.ts:14-24）。

**推断（需线上证据确认）**
- 用户的 22~25s 单次调用里，"握手握不上去就直接掐断"对应 **undici 10s connectTimeout**（因为 10s 恰好先于 21s 的 SYN 成功点触发；且错误被分类为 TIMEOUT/TRANSPORT 后触发"已重试模型请求(1/5)"）。**核实方式**：抓 DSH 日志里的错误串，若是 fetch failed + ConnectTimeoutError 即坐实。
- 用户环境是否设置了 HTTP(S)_PROXY：若设置，则用的是 DSH 的 proxy Agent（同样 4s/10s 默认）；若未设置，用 Node 默认 Agent（同样默认值）。两种情况结论一致，但日志里的 cause 文本会不同。

---

## 9. 附：关键代码原文摘录

~~~js
// undici/lib/core/connect.js:69  —— 建连超时默认 10 秒
timeout = timeout == null ? 10e3 : timeout

// undici/lib/dispatcher/client.js:307-309  —— 空闲 4 秒即回收
this[kKeepAliveDefaultTimeout] = keepAliveTimeout == null ? 4e3 : keepAliveTimeout
this[kKeepAliveMaxTimeout] = keepAliveMaxTimeout == null ? 600e3 : keepAliveMaxTimeout
this[kKeepAliveTimeoutThreshold] = keepAliveTimeoutThreshold == null ? 2e3 : keepAliveTimeoutThreshold

// undici/lib/web/fetch/index.js:129-152  —— abort 直接 destroy 连接
abort (error) {
  if (this.state !== 'ongoing') return
  this.state = 'aborted'
  ...
  this.connection?.destroy(error)     // <- socket 被销毁，不进池
  this.emit('terminated', error)
}

// undici/lib/web/fetch/index.js:2381-2389  —— 只有协议级结束后才摘除 abort 关联
onResponseEnd () {
  if (this.abort) fetchParams.controller.off('terminated', this.abort)
  fetchParams.controller.ended = true
  this.body?.push(null)
}

// openai/client.js:243  —— fetch 来源
this.fetch = options.fetch ?? Shims.getDefaultFetch()

// openai/client.js:1012  —— 真正发起请求（用全局 fetch）
const response = await (x509Fetch ?? this.fetch).call(undefined, url, fetchOptions);

// openai/core/streaming.js:148-153  —— 未正常收尾就 abort
finally {
  // If the user breaks, abort the ongoing request.
  if (!done) controller.abort()
}

// pi-ai/dist/api/openai-completions.js:557-563  —— 每次 stream new OpenAI（不是原因）
return new OpenAI({ apiKey, baseURL: model.baseUrl, dangerouslyAllowBrowser: true, fetch, defaultHeaders: headers });

// DSH packages/llm/llm-pi-ai/src/adapter.ts:454-456  —— 每次 stream 结束都 abort 一次派生信号
} finally {
  consumer.abort('pi-ai stream consumer stopped')
}

// DSH packages/util/http-proxy/src/install.ts:143-157  —— 进程级单例 Agent，无 keepAlive 调参
async function createPolicyDispatcher(policy) {
  const { Agent, Pool, ProxyAgent } = await import('undici')
  return new Agent({
    factory(origin, options) {
      const passed = options
      const proxy = proxyForUrl(policy, new URL(origin.toString()))
      if (proxy !== undefined) return new ProxyAgent({ ...passed, uri: proxy })
      return new Pool(origin, passed)
    },
  })
}
~~~


---

# 10. 收敛补充（Lead 确认结论后的独立复核，2026-10-29 15:0x）

> Lead 已确认：本机无任何代理（裸直连）、Electron 44.7.0 = Node 24.21.0 = 内置 undici 7.29.1、
> connectTimeout 实测 10.07s、空闲 2s 复用/5s 新建、DSH 全源码无 keepAlive/connectTimeout 覆盖、
> opencode-go 仅 models + apiKeyEnv、deepseek-v4.1-flash 走 openai-completions。
> 下面只写**补充与差异点**，不重复验证。

## 10.1 (a) SSE 正常读完后，连接是否归还池？——归还，且与"是否读满 body"无关

**判据是协议层，不是 JS 层**：
- `undici/lib/dispatcher/client-h1.js:771-837`：`onMessageComplete()` 由 llhttp 在解析到响应消息结束时触发（chunked 的终止块 / EOF），随即 `request.onResponseEnd(headers)`（:807）→ `setImmediate(client[kResume])`（:831）把 socket 放回池。
- `undici/lib/web/fetch/index.js:2381-2389`：`onResponseEnd()` 才摘除 abort 关联并 `ended = true`。

**实验证据（本机，3 次顺序请求统计新建连接数）**：
| 读法 | 新建连接数 |
|---|---|
| 读到 EOF | 1 |
| **读到 [DONE] 就停读（openai SDK 的真实行为）** | **1** |
| 读到 [DONE] 后 abort（模拟 DSH adapter finally） | 1 |

也就是说：pi-ai 的 `for await (const chunk of openaiStream)`（`pi-ai/dist/api/openai-completions.js:353-468`）在 SDK 收到 `[DONE]` 后 break、**不读 body 尾巴**，只要服务端已经把响应体发完，连接照样回池复用。

**两个前提/例外（重要）**：
1. **服务端必须真的结束响应体**。若服务端 `[DONE]` 后保持 SSE 响应不结束，则 `onResponseEnd` 永不触发、连接既不回池也不销毁；随后 abort → destroy。
2. **反压会推迟 message-complete**：`undici/lib/web/fetch/index.js:2376-2378` `if (this.body.push(bytes) === false) controller.pause()` —— 响应体较大、消费者又停读时 parser 被暂停，message-complete 到不了；此时 response body 被 GC 会 `stream.cancel('Response object has been garbage collected')`（`undici/lib/web/fetch/body.js:26`）→ 连接销毁。

结论：**"读到 [DONE]" 本身不是销毁点**；风险只来自"没读完 + 服务端没结束"或"被 GC"。

## 10.2 (b) 除"4s 空闲"和"abort"外，其它销毁点清单

| # | 销毁点 | 代码位置 | 本场景是否命中 |
|---|---|---|---|
| D1 | **建连超过 10s** | `undici/lib/core/connect.js:69`；Lead 实测 10.07s | **命中（主因）** |
| D2 | HTTP 错误响应后 SDK 主动 `CancelReadableStream(response.body)`（重试/抛错前） | `openai/client.js:866,869,888,891`；`internal/shims.js:85-96` | 可能（401/429/5xx 时每次都换连接） |
| D3 | `headersTimeout`/`bodyTimeout` 300s | `undici/lib/dispatcher/client.js:316-317` | 否 |
| D4 | 服务端 `Connection: close` / 半关闭 | `client-h1.js:655-707, 817-819` | 未知（视 opencode.ai 行为） |
| D5 | `shouldKeepAlive=false` 或 `socket[kReset]` | `client-h1.js:704-707, 820-826` | 随 D4 |
| D6 | response body 被 GC | `undici/lib/web/fetch/body.js:26` | 可能（停读 + 反压时） |
| D7 | `maxResponseSize` 超限 | `client-h1.js:754-757` | 否 |
| D8 | DSH adapter 每次 stream 结束无条件 `consumer.abort()` | `packages/llm/llm-pi-ai/src/adapter.ts:454-456` | 条件性（响应未在协议层结束时） |

**补充（不销毁但影响"要不要付握手"）**：TLS 会话缓存 `undici/lib/core/connect.js:41-59, 82`（`sessionCache`，默认 100 条）能让"新 TCP 连接"复用上次的 TLS session，`tls=0.36s` 就是这类收益；它**省不掉 TCP 三次握手**，所以对 21s 的 SYN 问题无效。

## 10.3 与 Lead 结论的差异 / 纠错

1. **"OpenAI SDK 默认 maxRetries=2"对本路径不成立**：pi-ai 在 requestOptions 里**显式传 `maxRetries: 0`**（`pi-ai/dist/api/openai-completions.js:192-196`），SDK 侧没有重试机会。所以"已重试模型请求(1/5)"的 5 次**全部来自 DSH llm-retry**，与 SDK 默认值无关（结论不冲突，原因表述需修正）。
2. **"· 1s" 的确切来源 = 计划退避时长的向上取整，不是已耗时**：
   - 数据：`llm/retry` 事件带 `retry / maxRetries / delayMs`（`packages/llm/llm-retry/src/index.ts:160-184`）；
   - 渲染：`packages/client/ui-chat/src/client/chat/MessageItem.tsx:42-44` `retrySeconds = Math.max(1, Math.ceil(ms/1000))`，`:99-113` 组合 `message.retry.status`；
   - 文案：`packages/client/ui-chat/src/client/locale.ts:166,168` —— `已重试模型请求` = retryState `started`（退避结束、请求已重新发出）；`{label}（{retry}/{maximum}） · {seconds}s`。
   - 对账：首轮 `localDelay = min(500ms × 2^0, 10000) × jitter(0.9~1.0) ≈ 450~500ms`（`llm-retry/src/index.ts:59-64`，`retry-policy.ts:15-17`）→ ceil → **1s**。与用户看到的 "(1/5) · 1s" 精确吻合。
3. **无代理这一点我这边有代码侧印证**：`packages/util/http-proxy/src/install.ts:176-187` 在 `policy.source === 'none'` 时**只记录 policy、不替换 dispatcher**；因此 DSH 用的是 Node 内置默认 Agent，默认值同样是 keepAliveTimeout 4s / connectTimeout 10s。**与 Lead 的实测完全一致**，也说明"改 dispatcher"这件事目前在 DSH 里根本没有入口（插件需要自己 setGlobalDispatcher 或在 profileOptions 里塞 fetch）。
4. **我补的一条独立证据**：asar 内 npm `undici@8.11.2` 的 `setGlobalDispatcher` **能接管 Node 24 内置 fetch**（`undici/lib/global.js:5-6,41-48` 同时写 `undici.globalDispatcher.2` 与 legacy `.1`；本机实测自定义 Agent 的 dispatch 被调用、hits=1）。这决定了插件的可行路径 (a)：**只调 setGlobalDispatcher 即可覆盖 openai SDK，无需改 pi-ai/DSH**。
5. 无冲突项：Lead 第 6/7/8 条我这边代码证据一致（分类 `stream.ts:51,59-66`；默认 5 次/500ms/10s/0.1；opencode-go 无 transport）。

**对插件的最小可行改动（复核后仍成立）**：
```
new undici.Agent({ connect: { timeout: 30_000 }, keepAliveTimeout: 120_000, keepAliveMaxTimeout: 600_000 })
→ setGlobalDispatcher(agent)   // 进程级，一次
```
配合"不要在流式期间随意 abort"（abort 必销毁 socket，P3/D8）。
