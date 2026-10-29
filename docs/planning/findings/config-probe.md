# 专项 C：用户实际配置与运行态取证

- 采集时间：2026-10-29 14:43–14:56（Asia/Shanghai）
- 采集者：config-probe（只读取证；未修改任何配置、系统代理或生产文件）
- 机器：DESKTOP-BA60D6A（Windows，DSH 桌面客户端 2026-10-28 21:44 启动，另有 14:51 启动的新实例）
- 标签约定：**【事实】**= 有命令输出/文件原文/日志事件直接证明；**【推断】**= 由事实推导，尚未直接观测

---

## 0. 结论速览（3 分钟版）

1. **【事实】用户机器当前没有走任何代理。** 系统代理 ProxyEnable=0（虽然残留 ProxyServer=http://127.0.0.1:7890），无 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY 环境变量，7890/7891/7897/10808/10809/1080/8080/8888 等常见代理端口**无一在监听**，也没有 Clash/v2ray/xray/sing-box 进程。opencode.ai 是直连（Cloudflare 172.65.90.20–23）。
   → 因此「每次新建 https-proxy-agent 导致不复用」在本机 **不成立**，不是本次的根因。
2. **【事实】opencode-go 在用户配置里只有 key 的来源 + 模型清单，没有任何传输参数。** cordis.patch.yml 的 opencode-go 段（第 83–286 行）只写了 models 和 apiKeyEnv: OPENCODE_GO_API_KEY：**没有** baseURL、transport、timeoutMs、maxRetries、proxy 覆盖。全文仅有的一处 timeout 是 mac-tunnel 的 healthTimeoutMs: 60000（第 334 行），与 LLM 无关。
3. **【事实】21 秒握手不是恒定的，是间歇性的。** 同一台机器同一条命令：
   - 2026-10-29 14:24（历史日志现场）：conn=21.225544 tls=21.587511 ttfb=23.009891 total=23.009957 code=200
   - 2026-10-29 14:48（本次实测，3 次）：conn=0.1978 / 0.1880 / 0.1850，TCP 独立探测 8 次为 0.172–1.186s
   → 说明不是 DSH/配置写错，而是**跨境链路上首个 SYN 被丢弃的概率性事件**（丢包时才要等 TCP 重传，约 21s）。
4. **【事实】连接复用确实能把握手成本降到零。** 同一条 curl 连发两个请求：第 1 个 num_connects=1（0.199s 建连），第 2 个 num_connects=0、总耗时 **0.258s**。历史日志里 keep-alive 实测：TCP+TLS 握手 21.5s；随后 #1 1.76s / #2 1.42s / #3 1.44s / #4 2.58s。
5. **【事实】DSH 的重试是 5 次、退避 0.5s→10s，用户看到的「(1/5)·1s」就是首次退避 ~0.47–0.55s 的展示值。** 运行态共记录 opencode-go 重试 **99 次**，maxRetries=5，policyKey=[normal,5,[EMPTY_RESPONSE,RATE_LIMIT,SERVER,TIMEOUT,TRANSPORT],500,10000,0.1]。
6. **【事实】真正让用户「等不及」的不止 21s：opencode-go 有 13 次卡满 300 秒才超时重试**（pi-ai stream idle timeout after 300000ms，实测耗时 300.0–316.0s），另有 30 次 Connection error.（耗时 0.16s–103.6s，中位 **47.1s**）。
7. **【事实】「已停止」是用户自己主动取消**：全库 turn/end 中 aborted 292 次；用户原话出现在 14:42–14:43 的会话里——「我发现这个握手握不上去就直接掐断了」「掐断是用户侧的决定，用户肯定会觉得这边一直没有回复等起来很烦」。
8. **【推断】完整因果链**：首个 SYN 丢包 → TCP 重传等 ~21s（期间界面无任何"连接中"反馈）→ 用户判断"卡死"手动停止（aborted）→ 被取消的请求连接被销毁 → 下一次请求重新握手，21s 重新计时；若这次赶上服务端 429/502 或空闲，则再叠加 0.5–10s 退避甚至 300s idle timeout。

---

## 1. 用户实际配置表（脱敏）

来源：C:\Users\Nicholas023\.dsh\profiles\desktop\cordis.patch.yml（用户 patch 层，最终生效）

| 配置项 | 实际值 | 证据（文件:行 + 原文） |
|---|---|---|
| 默认 provider | opencode-go | cordis.patch.yml:307-312  - id: agent-default-model / provider: opencode-go |
| 默认 model | deepseek-v4.1-flash | cordis.patch.yml:311  model: deepseek-v4.1-flash |
| reasoningEffort | low | cordis.patch.yml:312  reasoningEffort: low |
| apiKey 来源 | 环境引用 OPENCODE_GO_API_KEY | cordis.patch.yml:286  apiKeyEnv: OPENCODE_GO_API_KEY |
| 实际 key（脱敏） | oc_sk_ 开头，长度 51 | .credentials.yaml → refs: OPENCODE_GO_API_KEY（未泄露完整值） |
| baseURL | **未配置**（继承 pi-ai 模型目录端点） | cordis.patch.yml:83-286 整段无 baseURL；provider-data.generated.ts:36  'opencode-go': { env: ['OPENCODE_API_KEY'] } 无 defaultBaseURL |
| 实际端点 | https://opencode.ai/zen/go/v1 | 本次实测 GET /zen/go/v1/models → HTTP 200；历史日志 /zen/v1/chat/completions → HTTP 403 Model access is disabled（go 套餐只开放 /zen/go） |
| transport | **未配置** | cordis.patch.yml 全文无 transport 键 |
| timeoutMs | **未配置** | cordis.patch.yml 全文无 LLM timeout 键（唯一 timeout 是 mac-tunnel:334 healthTimeoutMs: 60000） |
| maxRetries | **未配置**（DSH 适配层对 pi-ai 传 0，重试由 llm-retry 层承担） | 运行态事件 maxRetries: 5 来自 llm-retry 默认策略 |
| 重试策略 | 5 次；退避 500ms 起、上限 10000ms、抖动 0.1 | 运行态 policyKey（见 4.2 原文） |
| 代理 | **无** | 见第 2 节 |
| 模型清单 | 30 个 opencode-go 模型（deepseek/glm/kimi/grok/claude…） | cordis.patch.yml:83-286 |
| 其他相关 | mac-tunnel 把 127.0.0.1:10010 SSH 转发到内网（供 cucc provider 用），**与 opencode-go 无关** | cordis.patch.yml:314-334 + cucc 的 baseURL: http://127.0.0.1:10010/CUCCAI-llm-hub（第 32 行） |

**配置层结论【事实】**：opencode-go 完全跑默认值，用户从未显式设置超时/重试/传输方式；因此"DSH 没复用长连接"不能用"用户配置写错"解释，只能从 pi-ai/SDK 默认行为解释（由其他专项负责）。

> 补充【事实】：storages/workspace.json、schedule.json、.dshw-turn.json、profile/package.json 中均无 opencode 关键字命中；opencode-go 配置唯一来源就是 cordis.patch.yml。

---

## 2. 代理检查（决定是否每次新建 proxy agent）

| 检查项 | 结果 | 命令/证据 |
|---|---|---|
| 系统代理开关 | ProxyEnable = 0（关闭） | HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings |
| 系统代理地址（残留） | ProxyServer = http=http://127.0.0.1:7890;https=http://127.0.0.1:7890（因开关关闭而不生效） | 同上 |
| 自动配置脚本 | AutoConfigURL = 空 | 同上 |
| 环境变量 | 无 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY 任何一项 | Get-ChildItem Env: 过滤 PROXY → 空 |
| 代理端口监听 | 7890/7891/7897/10808/10809/1080/8080/8888/1087/2080 **全部无监听** | Get-NetTCPConnection -State Listen 过滤 |
| 代理进程 | 无 clash/v2ray/xray/sing-box/verge/nekoray/mihomo 等 | Get-Process 名称匹配 |
| DSH 配置内 proxy 项 | 无 | cordis.patch.yml 无 proxy 键 |

**【事实】结论：直连，不走代理。** 所以"每次请求 new https-proxy-agent → 新连接"这一机制在本机当前状态下**未被触发**。
> 【推断】若用户日后开启 127.0.0.1:7890，则 DSH 是否会因每个请求新建 proxy agent 而破坏复用，需要另外验证——那时才适用代理 agent 复用问题。

---

## 3. 实测网络数据表

### 3.1 北京时间 14:48 本次实测（当前链路良好）

curl.exe 时间分解（单位秒）：

| 序号 | 目标 | dns | conn | tls | ttfb | total | http |
|---|---|---|---|---|---|---|---|
| 1 | https://opencode.ai/ | 0.00511 | **0.19781** | 0.54272 | 0.82069 | 0.87307 | 200 |
| 2 | https://opencode.ai/ | 0.00375 | **0.18803** | 1.15398 | 1.44204 | 1.72087 | 200 |
| 3 | https://opencode.ai/ | 0.00372 | **0.18498** | 0.54021 | 0.83921 | 0.90707 | 200 |
| 4 | /zen/go/v1/models（带 key） | 0.00439 | **0.19993** | 0.61394 | 0.89173 | 0.89178 | 200 |
| 5 | /zen/go/v1/models（带 key） | 0.00422 | **0.18249** | 0.57112 | 0.84185 | 0.84192 | 200 |
| 6 | POST /zen/go/v1/chat/completions | 0.00423 | **0.17786** | 0.53030 | 0.78102 | 0.78105 | 400* |
| 7 | POST /zen/go/v1/chat/completions | 0.00586 | **0.19815** | 0.55273 | 0.80227 | 0.80229 | 400* |

\* POST 用最小 payload（max_tokens:1）被服务端以 400 拒绝，**但握手与 TTFB 计时依然有效**（连接与传输都真实发生）。

### 3.2 连接复用对照（同一条 curl 连续 2 个 URL）

| 请求 | conn | total | num_connects | 说明 |
|---|---|---|---|---|
| GET https://opencode.ai/ | 0.19879 | 1.03884 | **1** | 新建连接 |
| GET /zen/go/v1/models | 0.00000 | **0.32941** | **0** | **复用同一条连接，省掉整个握手** |
| POST chat/completions #1 | 0.17553 | 0.78045 | 1 | 新建 |
| POST chat/completions #2 | 0.00000 | **0.25828** | **0** | 复用 |

### 3.3 TCP 握手独立探测（TcpClient，8 次，10s 间隔）

~~~
probe1 ok connect=0.229s   probe2 ok connect=0.185s   probe3 ok connect=0.172s
probe4 ok connect=1.186s   probe5 ok connect=0.177s   probe6 ok connect=0.176s
probe7 ok connect=0.349s   probe8 ok connect=0.176s
~~~
probe4 的 1.186s 出现了一次重传级延迟，说明链路**确实存在丢包**，只是此刻没丢到需要 21s 重传的程度。

### 3.4 历史对照（14:24，来自 DSH 会话日志原文，证实 21s 存在）

同一台机器、同一个 opencode-go key、直连：

| 目标 | dns | conn | tls | ttfb | total | code |
|---|---|---|---|---|---|---|
| opencode-go v4.1-flash | 0.004306 | **21.225544** | 21.587511 | 23.009891 | 23.009957 | 200 |
| opencode-go v4.1-flash (2) | 0.005354 | **21.256456** | 21.613509 | 22.852451 | 22.852516 | 200 |
| /zen/v1/chat/completions | — | — | — | — | **21.9s** | 403（Model access is disabled） |

keep-alive 复用对照（同一会话内，python http.client 复用一条连接）：

~~~
TCP+TLS 握手耗时 21.5s
#1 HTTP 200 | 1.76s
#2 HTTP 200 | 1.42s
#3 HTTP 200 | 1.44s
#4 HTTP 200 | 2.58s
~~~

**【事实】两次测量（14:24 的 21.2s vs 14:48 的 0.18s）证明：21s 是间歇性丢包，不是固定属性。**
**【推断】丢的正是首个 SYN**（conn≈21.2s 且 DNS 0.004s、TLS 与 conn 差 0.36s、ttfb 1.4s，符合 TCP SYN 重传时序），与用户此前的 curl 分解一致。

---

## 4. 运行态日志证据摘录

### 4.1 数据来源与方法

- 路径：C:\Users\Nicholas023\.dsh\sessions\<project>\<session>\session.v4.jsonl.zstd
- **格式坑**：这些文件是**多帧 zstd**（每帧一条/一批事件），Node zlib.zstdDecompressSync 默认只解第一帧（不足 300 字节）。需按 magic 28 B5 2F FD 切帧逐帧解压。
- 覆盖：258 个会话文件、**200,931 条事件**；其中 llm/retry 129 条、llm/retry-started 126 条、assistant/attempt 324 条。
- 相关项目：02-DSH开发、03-应用项目\流萤AI、dsh-ops 等。

### 4.2 重试策略原文（界面「已重试模型请求(1/5) · 1s」的来源）

~~~
{"type":"llm/retry","seq":11852,"time":1793255011377,
 "data":{"provider":"opencode-go","turn":237,"step":1,
 "policyKey":"[\"normal\",5,[\"EMPTY_RESPONSE\",\"RATE_LIMIT\",\"SERVER\",\"TIMEOUT\",\"TRANSPORT\"],500,10000,0.1]",
 "retry":1,"maxRetries":5,"delayMs":540.0919146438933,
 "failure":{"message":"terminated","code":"TRANSPORT"}}}
~~~
（.dsh\sessions\--D-DSH-Files-v2-03-~5E94~7528~9879~76EE-~6D41~8424AI--\session-6a0f61d7-...\session.v4.jsonl.zstd, seq=11852, 2026-10-29T06:23:31Z）

- 【事实】maxRetries=5、retry 从 1 计数、退避初值 500ms、上限 10000ms、抖动 0.1。
- 【事实】首次实际 delayMs 观测值 470–548ms。
- 【推断】界面 "· 1s" 是这个 ~0.5s 退避向上取整/四舍五入的展示值；之后 2 次约 1.0s、4 次约 2s… 指数退避。

### 4.3 opencode-go 失败码分布（99 次重试，全库统计）

| failure.code | 次数 | 典型 message | 单次尝试耗时 min / 中位 / max |
|---|---|---|---|
| TRANSPORT | 34 | Connection error. (30) | **0.156s / 47.100s / 103.593s** |
|  |  | terminated (2) | 89.964s / — / 218.581s |
|  |  | Anthropic stream ended before message_stop (1) | 266.278s |
|  |  | Stream ended without finish_reason (1) | 35.473s |
| RATE_LIMIT | 36 | 429 ... [ttft_admission_refused] the cell is at capacity | 0.670s / 2.441s / 12.696s |
|  |  | 429 ... Endpoint is unavailable. | 1.601s / 1.726s / 2.028s |
| TIMEOUT | 14 | pi-ai stream idle timeout after 300000ms (13) | **300.018s / 300.060s / 316.016s** |
|  |  | Request timed out. (1) | 10.618s |
| SERVER | 9 | 502 ... Endpoint is unavailable. (6) | 1.850–6.826s |
|  |  | 502 Cloudflare (1)、520 (2) | 10.109–35.630s |
| EMPTY_RESPONSE | 6 | model "glm-5.3-flash" returned a completed response with no content | 3.165–13.221s |

### 4.4 按模型归因（同库统计）

| 模型 | 请求 step 数 | 重试次数 | 失败码 |
|---|---|---|---|
| **deepseek-v4.1-flash（默认）** | 18,507 | **88** | TIMEOUT 14、TRANSPORT 33、SERVER 8、RATE_LIMIT 33 |
| glm-5.3-flash | 205 | 6 | EMPTY_RESPONSE 6 |
| claude-haiku-5-5 | 157 | 1 | TRANSPORT 1 |
| 其他（gpt-6-luna/longcat…） | 4 | 2 | SERVER/RATE_LIMIT |

**【事实】默认模型 deepseek-v4.1-flash 的失败率约 0.48%（88/18507），但一旦命中，代价是 47s / 300s 级等待。**

### 4.5 用户「掐断/已停止」的原话与语义

- 14:42:38 用户（发截图）：「给你补一个我这边实际使用的问题，我发现这个握手握不上去就直接掐断了」
- 14:43:31 用户：「掐断是用户侧的决定，用户肯定会觉得这边一直没有回复等起来很烦」
- 全库 turn/end 统计：completed 1236、aborted **292**、error 44、max-tokens 1。
  → 【事实】"已停止"对应 turn/end.reason.kind = "aborted"，是客户端取消，不是 DSH 自动掐断。

### 4.6 21s 现场的直接日志（turn 237，14:22–14:26）

~~~
[06:22:01] user/message "我去opencode的后台看延迟没这么高啊"
[06:23:31] llm/retry retry=1 delayMs=540 failure={message:"terminated",code:"TRANSPORT"}   ← 等了约 90s 才失败
[06:23:31] llm/retry-started retry=1
[06:23:46] assistant/message（重试后成功返回推理内容）
[06:24:33] tool/result: "opencode-go v4.1-flash: dns=0.004306 conn=21.225544 tls=21.587511 ttfb=23.009891 total=23.009957 code=200"
[06:25:43] tool/result: "TCP+TLS 握手耗时 21.5s / #1 1.76s / #2 1.42s / #3 1.44s / #4 2.58s"
~~~

**【事实】从用户发出消息到第一次 TRANSPORT 失败约 90 秒；期间界面无连接阶段反馈，随后出现"重试(1/5)"。**

---

## 5. 明确回答三个问题

### Q1：用户机器上是否走代理？
**否（事实）。** 系统代理关闭、无代理环境变量、无代理进程/端口监听。opencode.ai 直连 Cloudflare 172.65.90.20–23。
因此「代理 agent 每次新建」这条假设在本机**当前状态不成立**；如后续开启 7890 代理，需重新验证。

### Q2：握手是否仍 21s？
**是间歇性的，不是恒定（事实）。**
- 14:24 实测（历史日志）：conn = 21.2255s / 21.2565s，总耗时 23.0s / 22.9s。
- 14:48 本次实测：conn = 0.185–0.198s（curl 3 次）、TCP 探测 8 次 0.172–1.186s。
- 复用测试：首请求握手 0.18–0.20s，第二请求 0 建连、0.258–0.329s；历史 21.5s 握手后复用为 1.42–2.58s。
→ 21s = 首个 SYN 被丢后 TCP 重传等待，链路质量差时必现、好时消失。

### Q3：DSH 实际的重试与超时表现？
- **重试**：llm-retry 层最多 5 次；退避 500ms 起、指数增长到上限 10s、抖动 10%；界面 "· 1s" ≈ 首次 0.47–0.55s 的展示值。5 次是硬上限（本机配置未改）。
- **超时**：opencode-go 无显式 timeoutMs 配置；实测最耗时的是 **pi-ai 流空闲超时 300000ms（300s）**，13 次卡满 5 分钟才重试；另有 1 次 Request timed out. 10.6s。
- **传输失败**：Connection error. 30 次，耗时跨度 0.16s–103.6s、中位 47.1s（不是固定 21s，说明还叠加了多 IP 重试/服务端行为，具体归因见传输层专项）。
- **用户侧表现**：21s 握手 + 可能叠加 47s/300s → 界面长时间无回复 → 用户主动"停止"（aborted）。

---

## 6. 证据清单与局限

### 6.1 关键证据文件
| 用途 | 路径 |
|---|---|
| 用户配置 | C:\Users\Nicholas023\.dsh\profiles\desktop\cordis.patch.yml（83/286/307-312 行） |
| 凭据（已脱敏） | C:\Users\Nicholas023\.dsh\.credentials.yaml → refs.OPENCODE_GO_API_KEY（oc_sk_…，len=51） |
| 会话日志 | C:\Users\Nicholas023\.dsh\sessions\<project>\<session>\session.v4.jsonl.zstd（多帧 zstd） |
| 21s 现场 | ...\--D-DSH-Files-v2-03-~5E94~7528~9879~76EE-~6D41~8424AI--\session-6a0f61d7-...\session.v4.jsonl.zstd，seq=11852/11867/11868/11902 |
| 重试样例 | ...\--D-DSH-Files-v2-02-DSH~5F00~53D1-~5386~4EE3dsh~6E90~7801--\session-b342f0eb-...，seq=1393 |
| 代理注册表 | HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings |
| 中间产物 | C:\Users\Nicholas023\AppData\Local\Temp\dsh-probe\（durations.json / llm-events.ndjson / scan2.json 等） |

### 6.2 局限
1. 【局限】本次采样窗口（14:43–14:56）链路恰好正常，**无法在线复现 21s**；21s 结论来自 14:24 的会话日志原文 + 用户此前 curl 分解。
2. 【局限】POST chat/completions 最小 payload 返回 400，未取到 200 的真实端到端耗时；但握手/TTFB 计时与复用对照有效，200 场景耗时由历史日志佐证。
3. 【局限】无法读取 DSH 运行进程的环境块；只能证明系统级/用户级无代理变量。进程级是否有代理变量未验证（若有，也只影响该进程，而 curl 直连同样 21s，说明不是代理导致）。
4. 【局限】durations.json 的"单次尝试耗时"是用 step/start 或 retry-started 与 llm/retry 事件时间差估算；若期间有其他等待（如工具执行），可能略微偏大。已剔除明显异常（attemptMs 超过 300s 的空闲超时单列）。


---

## 7. 补充：对 Lead 收敛结论的独立证据/纠错（14:56 追加）

### 7.1 (a) cordis.patch.yml 是否有隐藏的 timeout/retry 配置 —— 已确认：没有 【事实】

对用户 patch 文件全文（373 行）做精确检索 timeout|retry|transport|maxRetries|keepAlive|connectTimeout|fetch|proxy，仅 2 处命中，均与 LLM 无关：

~~~
334: healthTimeoutMs: 60000        ← mac-tunnel 插件的 SSH 隧道健康检查
362: fetchProvider: deepseek-fetch-api  ← web 插件的抓取后端
~~~

opencode-go 配置段（第 83–286 行）只有 models 清单 + apiKeyEnv: OPENCODE_GO_API_KEY（第 286 行）。**结论：没有隐藏的 transport/timeoutMs/retryPolicy/keepAlive 覆盖，全部走默认值。**

### 7.2 (b) 本次实测 conn 数据摘要 【事实】

| 测量 | 结果 |
|---|---|
| curl 3× https://opencode.ai/ | conn = 0.1978 / 0.1880 / 0.1850 s（total 0.87–1.72s） |
| TCP 探测 8 次（10s 间隔） | 0.229 / 0.185 / 0.172 / **1.186** / 0.177 / 0.176 / 0.349 / 0.176 s |
| 复用对照（同一 curl 两请求） | 第 1 个 num_connects=1、conn 0.199s；第 2 个 **num_connects=0、total 0.258s** |
| 历史 14:24 现场（会话日志原文） | conn = **21.225544 / 21.256456** s，ttfb = 23.009891 / 22.852451 s |
| 历史 keep-alive 测试 | 握手 21.5s 后 #1 1.76s / #2 1.42s / #3 1.44s / #4 2.58s |

### 7.3 (c) DSH 实际相邻请求间隔是否 >4s —— 是，绝大多数远超 4s 【事实】

统计方法：全库 258 个会话、opencode-go 相邻两次 step/start（即相邻两次模型请求）的时间差，共 18,694 个样本：

| 指标 | 数值 |
|---|---|
| 中位间隔 | **12.98 s** |
| P90 间隔 | 57.47 s |
| 最小间隔 | 1.51 s |
| **> 4s 的占比** | **92.8%（17,339 / 18,694）** |

间隔直方图：<1s: 0；1–4s: 1,353；4–10s: 5,933；10–60s: 9,627；>60s: 1,781

另外，相邻两个 turn 之间（用户阅读回复/思考时间）共 1,335 个样本，中位 44.93s，**89.0% > 4s**。

**【事实】结论：DSH 的实际请求节奏（中位 13s）几乎总是超过 undici 默认 keepAliveTimeout≈4s，连接池里的连接在下次请求前早已被关闭，因此每个请求（在链路上）都要重新做 TCP+TLS 握手。**
这也与"单次调用固定 22~25 秒"吻合：每次请求都是冷连接。

### 7.4 重要新证据：opencode.ai 的 4 个 A 记录中有 2 个是黑洞 【事实】

对 opencode.ai 的 4 个 Cloudflare 地址逐个强制解析测试（curl --resolve opencode.ai:443:<ip>）：

| IP | --connect-timeout 10 | 不设 connect-timeout（-m 45） |
|---|---|---|
| 172.65.90.20 | **10.004s 超时失败（exit 28）** | **21.047s 失败（exit 28）** |
| 172.65.90.21 | 0.178s 成功（HTTP 200） | — |
| 172.65.90.22 | **10.004s 超时失败（exit 28）** | **21.050s 失败（exit 28）** |
| 172.65.90.23 | 0.179s 成功（HTTP 200） | — |

- 【事实】两个地址（.20/.22）**完全不可达**（SYN 无响应），另两个 0.18s 可达。
- 【事实】不可达地址的连接在 **~21.0s** 失败——这是 Windows 默认 SYN 重传耗尽（TcpMaxConnectRetransmissions）后的超时，**恰好等于用户看到的 21.2s**；而能成功的采样点（14:24 的 conn=21.2255s + code=200）说明那次 SYN 重传第 N 次赶上了。
- 【推断，需传输层专项确认】在 undici 每地址 connectTimeout=10.07s 的模型下：一次请求若先命中 1–2 个黑洞地址，就要付 10s（或 20s）超时，再连上可用地址（0.18s）+ TLS（约 0.36s）+ TTFB（约 1.4s）≈ **11.5s / 21.5s**；后者正好落在用户"固定 22~25 秒"的区间。**即"固定 22s"很可能是"1 个黑洞地址 10s 超时 + 一个可见地址握手成功"或"Windows 层 21s SYN 重传成功"两种机制叠加的产物。**
- 这也解释了 DSH 运行态 30 次 Connection error. 的中位耗时 **47.1s**：接近 4 个地址依次失败（4 × 10s≈40s）或跨重试累计；具体地址选择顺序需用 undici 的 happy-eyeballs 行为核对（属传输层专项）。

### 7.5 与 Lead 结论的对照：无冲突，两点补充/纠错

| Lead 结论 | 本专项证据 | 判定 |
|---|---|---|
| 无任何代理 | 系统代理关闭、无代理 env、无代理进程/端口 | 一致（独立复核） |
| 无 keepAlive/connectTimeout 覆盖 | patch 全文仅 2 处无关命中 | 一致 |
| undici connectTimeout=10e3 | 黑洞 IP 在 10.004s 失败（--connect-timeout 10）；但不设 connect-timeout 时 Windows 也会在 21.05s 失败 | 一致，**补充**：21s 是 OS 层 SYN 重传超时，不是 undici |
| keepAliveTimeout≈4s | DSH 实际相邻请求 92.8% > 4s（中位 12.98s） | 一致，**并给出用户机器上的量化证据** |
| retry 5 次 / 500ms 起 / 10s 上限 / 0.1 抖动 | 运行态 policyKey 原文 + delayMs 实测 470–548ms | 一致 |
| 21s 是间歇性 | 14:24 为 21.2s；14:48 为 0.18s；新发现 .20/.22 恒黑洞 | 一致，**补充根因定位到具体 IP** |

### 7.6 关于界面「已重试模型请求(1/5) · 1s」的确切来源 【事实 + 推断】

- 【事实】运行态重试事件里，首条 llm/retry 的 delayMs 实测为 470.1 / 476.0 / 482.8 / 494.4 / 525.1 / 532.5 / 540.1 / 548.1 / 548.7 ms（首次重试全部落在 0.47–0.55s）。
- 【事实】同一次重试的实际耗时（从 step 开始到失败）是 89.964s（"terminated"），远大于界面显示的 1s。
- 【推断】因此 "· 1s" **不是 elapsed（已耗时）**，而是 llm-retry 排定的 **delayMs 退避时长的秒级取整显示**（0.5s → 1s）；"1/5" 是 retry/maxRetries。后续重试依次约 1s、2s、4s、8s（封顶 10s），与 policyKey 的指数退避一致。
- 建议 UI 文案区分「重试等待 1s」与「上次尝试耗时 90s」——用户正是因为只看到 1s 而误以为"D drows 立刻掐断"。


### 7.7 自我纠错：undici 目前并不会稳定吃满 2×10s 【事实】

用与 DSH 完全相同的 Node 24.21.0（bundled node.exe）跑内置 fetch，3 个全新进程分别请求 https://opencode.ai/：

~~~
#1 -> HTTP 200, 1013ms
#2 -> HTTP 200, 1063ms
#3 -> HTTP 200,  967ms
~~~

- 【事实】3/3 都在约 1.0s 内成功，说明 undici 当前的地址选择/autoSelectFamily 行为能快速绕开黑洞地址 .20/.22，**并没有付 2×10s**。
- 【结论修正】7.4 中"22s≈2×10s 超时"只是**一种可能**，不能作为定论。用户当时观察到的 22~25s 需要传输层用事件时间线（每次尝试的起止时间 + 目标 IP）来拆解：可能是"黑洞地址 10s 超时 + 第二地址成功"、也可能是"全链路段 SYN 丢弃导致 Windows 21s 重传成功后成功"，还可能是"首次尝试 10s 超时失败 → llm-retry 0.5s → 第二次成功"的累计。
- 本专项能确定的是：**黑洞地址确实存在（.20/.22）**、**21s 是 OS 层 SYN 重传超时**、**DSH 请求间隔 92.8% > 4s（复用不了）**、**重试参数与界面 1s 的来源**；"22s 每单的确切构成"留给传输层专项。
