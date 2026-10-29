# DSH opencode 黑洞 IP 过滤插件 · 实现方案

> 版本：v0.1（方案稿，待评审）
> 依据：`grill-决策记录.md` 的 D1~D20 全部决策 + `DSH-opencode-长连接失效根因报告.md` 的实测结论
> 本文只讲「怎么做」，不重复「为什么」；为什么见根因报告。

---

## 1. 目标与非目标

### 1.1 目标

让 DSH 在访问 `opencode.ai` 时**永远不去连接已知黑洞 IP**，从而消除「命中黑洞 → SYN 重传 21 秒 → 超时重试 74 秒无响应」这条失败路径。

### 1.2 非目标（明确不做，防止范围膨胀）

- ❌ 不做通用 IP 优选，只认 `opencode.ai`（D14）；
- ❌ 不做连接保活（D6），`keepAliveTimeout` 保持默认；
- ❌ 不改 `connect timeout`（保持 10 秒，D7）；
- ❌ 不做本地代理/连接保管器（D1）；
- ❌ 不持久化任何状态（D4）；
- ❌ 不改系统 hosts / DNS 设置；
- ❌ 不碰 DSH 业务代码，只做插件（D5）。

---

## 2. 原理（一句话）

DSH 的 LLM 请求最终走 Node 内置 fetch，连接池由 undici 全局 dispatcher 决定。
我们在 undici Agent 的 `connect.lookup` 上挂一个钩子：**每次 DNS 解析时剔除黑名单里的 IP、只返回 IPv4**，
于是 DSH 永远只会连可用 IP。

此路径已实测验证（详见 §9 验证记录）：

    强制 lookup 指向 172.65.90.21 → HTTP 200, 728ms
    强制 lookup 指向 172.65.90.20 → 5568ms 后 UND_ERR_CONNECT_TIMEOUT
    → 证明 lookup 完全掌控连接目标

---

## 3. 总体架构

    ┌─────────────────────────── DSH 主进程（Electron / Node 24）───────────────────────────┐
    │                                                                                      │
    │   ┌──────────────┐   setGlobalDispatcher   ┌────────────────────────────────────┐     │
    │   │ Host 插件     │ ──────────────────────> │ undici Agent（我们创建）            │     │
    │   │ (src/index.js)│                         │  connect: {                        │     │
    │   │              │                         │    timeout: 10000,                 │     │
    │   │  probe.js    │                         │    lookup: <我们的过滤函数>          │     │
    │   │  blacklist.js│                         │  }                                 │     │
    │   │  guard.js    │                         └───────────────┬────────────────────┘     │
    │   └──────┬───────┘                                         │                          │
    │          │ webServer.register('/opencode-ip-guard/status')  │ Node 内置 fetch           │
    │          │                                                 ▼                          │
    │          │                                     https://opencode.ai/zen/go/v1          │
    └──────────┼─────────────────────────────────────────────────────────────────────────────┘
               │ HTTP GET（轮询 / 点击刷新）
    ┌──────────▼───────────┐
    │ Client 面板（client.js）│  DSH Web GUI 会话头小卡
    └──────────────────────┘

---

## 4. 模块划分

### 4.1 文件结构

    opencode-ip-guard/
      package.json
      cordis.patch.yml
      LICENSE                  Apache-2.0
      README.md / README.zh.md
      CHANGELOG.md
      .npmignore
      src/
        index.js               Host 壳：加载实现、注册路由、挂载生命周期
        guard.js               启动编排：代理检测 → 决定启用/禁用 → 注入 dispatcher
        probe.js               TLS 探测（单个 IP 与批量）
        blacklist.js           黑名单 + 状态机 + 时间戳
        lookup.js              DNS 过滤钩子（核心）
        dispatcher.js          undici Agent 的创建与注入
        status.js              状态快照（供路由与测试）
        client.js              Client 面板
      test/
        lookup.test.mjs        过滤逻辑单测
        blacklist.test.mjs     状态机单测
        probe.test.mjs         探测单测（本地 TLS 服务器）
        guard.test.mjs         代理检测单测
        acceptance.mjs         三条验收脚本（见 §10）
      docs/
        DESIGN.md              本文件
        ACCEPTANCE.md          验收手册

### 4.2 各模块职责

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `index.js` | 导出 name/inject/apply；动态加载 impl；捕获所有异常；不返回业务对象 | 不写业务逻辑 |
| `guard.js` | 检测代理 → 决定是否启用；编排探测；注入 dispatcher；暴露 start/refresh/status | 不实现探测细节 |
| `probe.js` | 对单个 IP 做 TLS 握手探测（超时、SNI、证书校验）；批量并发 | 不发 HTTP 请求 |
| `blacklist.js` | 维护 `Map<ip, {state, ms, at}>`；提供 filter()/rebuild()/snapshot() | 不做 IO |
| `lookup.js` | 实现 undici 的 lookup：调 dns.resolve4 → 过滤黑名单 → 只返回 IPv4 | 不自己缓存 DNS 结果 |
| `dispatcher.js` | new Agent({connect:{timeout, lookup}}) + setGlobalDispatcher | 不决定何时注入 |
| `status.js` | 组装状态快照（状态、黑名单、上次探测时间、探测明细） | 不持状态 |
| `client.js` | 会话头小卡；轮询状态；点击触发重探 | 不做任何过滤逻辑 |

---

## 5. 数据流

### 5.1 启动流程

    DSH 启动
      → 启动器调用 installProxyFromEnvironment()（在插件挂载前）
      → 本插件 apply(ctx, rawConfig)
          → guard.start()
              ├─ 检测代理（§6.4）
              │    ├─ 有代理 → state = 'disabled_by_proxy'，注册只读状态路由，结束
              │    └─ 无代理 → 继续
              ├─ dispatcher.install()   ← 立即注入，先让过滤生效（此时黑名单为空=不过滤）
              ├─ 注册状态路由 /opencode-ip-guard/status
              ├─ probe.run()  ← 异步，不 await（D8）
              └─ 返回（不阻塞启动）

### 5.2 一次模型请求的完整路径

    DSH 发起 LLM 请求 → Node 内置 fetch → undici 需要建连
      → 调用我们的 lookup(hostname, options, cb)
          ├─ dns.resolve4(hostname)        ← 实时查，不缓存（D 默认）
          ├─ blacklist.filter(ips)          ← 剔除黑洞 IP
          ├─ 若过滤后为空 → 返回原始列表的第一个（绝不把连接搞死）
          └─ 返回一个 IPv4 地址（family=4）
      → 连上可用 IP → 正常请求

> 关键：`net.connect` 的非 all 模式只接受**单个地址**，所以 lookup 必须自己选出「要连哪一个」。
> 我们选「过滤后列表中的第一个」。这同时也天然实现了 IPv4 强制。

### 5.3 探测流程

    probe.run():
      ips = dns.resolve4('opencode.ai')     ← 每次探测都重新解析
      并发对每个 ip 做 TLS 握手（超时 10s，SNI=opencode.ai，验证证书）
      结果写入 blacklist：ok（记录耗时）/ black（超时或失败）
      若全部失败：
          state = 'degraded'，黑名单**不生效**（全部放行）
          60s 后重探；仍失败 → 再等 120s 重探；第三次失败 → state='failed'，放弃（D9）

### 5.4 面板点击流程

    点击 → client 调 POST /opencode-ip-guard/refresh
      → host 触发 probe.run()（重探当前 DNS 的 IP）
      → 用重探结果**重建**黑名单（恢复的 IP 会被移出、新增黑洞会被加入）（D16）
      → client 轮询/立即拉取新状态并重绘

---

## 6. 关键实现细节

### 6.1 探测函数（已实测的形态）

    // probe.js 核心：连指定 IP，但用真实域名做 SNI 与证书校验
    tls.connect({
      host: ip,                    // 连哪个 IP
      port: 443,
      servername: 'opencode.ai',   // SNI
      rejectUnauthorized: true,    // 验证证书链
    })
    // 10 秒超时 → 判定黑洞

实测结果（本机）：

    .21 → TLSv1.3 authorized=true CN=opencode.ai 371ms  → 可用
    .23 → TLSv1.3 authorized=true CN=opencode.ai 348ms  → 可用
    .20 → timeout 10005ms                               → 黑洞
    .22 → timeout 10012ms                               → 黑洞

### 6.2 lookup 钩子（核心）

    // lookup.js：必须同时兼容 all / 非 all 两种回调形态
    function lookup(hostname, options, callback) {
      dns.resolve4(hostname, (err, addresses) => {
        if (err || !addresses.length) {
          // 解析失败：交回系统解析器，绝不因为我们的 bug 断网
          return dns.lookup(hostname, options, callback);
        }
        let usable = addresses.filter(ip => !blacklist.isBlack(ip));
        if (usable.length === 0) usable = addresses;   // 全被过滤 → 全部放行
        const chosen = usable[0];
        if (options.all) callback(null, [{ address: chosen, family: 4 }]);
        else callback(null, chosen, 4);
      });
    }

注意点：

- 只用 `dns.resolve4`，天然不会返回 IPv6（D：禁 IPv6）；
- 解析失败时**回退到 `dns.lookup`**，保证插件自身故障不会让 DSH 连不上网；
- 过滤后为空时**回退到原始列表**，避免自锁；
- 不缓存 DNS 结果（默认决策），保证始终跟随最新解析。

### 6.3 dispatcher 注入

    const { Agent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new Agent({
      connect: { timeout: 10000, lookup },   // 超时与运行时口径一致（D7/D19）
      // 不设置 keepAliveTimeout（D6：不做保活）
    }));

已验证：外部 undici（8.x）的 Agent 通过 `setGlobalDispatcher` 能被 Node 内置 fetch（undici 7.29.1）接受，
连接复用行为正常（跨版本可用）。

### 6.4 代理检测（D11）

检查以下环境变量（大小写都查，取 DSH 规范化后的值）：

    HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / HTTP_PROXY 小写 / https_proxy / all_proxy

判定为「配置了代理」的条件：值非空、能解析为 URL、协议为 `http:` 或 `https:`、且未被 NO_PROXY 全覆盖。

命中则：**不注入 dispatcher**，state = `disabled_by_proxy`，面板显示「已因代理配置禁用」。

> 理由：DSH 的 `installProxyFromEnvironment()` 已经装好了代理 dispatcher，我们再 setGlobalDispatcher 会覆盖它，
> 导致代理失效。而走代理的用户本来就不需要本插件。

### 6.5 状态快照（供面板与验收）

    interface StatusSnapshot {
      state: 'idle' | 'probing' | 'ready' | 'degraded' | 'failed' | 'disabled_by_proxy';
      enabled: boolean;
      reason?: string;                  // 禁用/降级原因
      lastProbeAt: number | null;       // 上次探测的 Unix ms（D18）
      entries: Array<{
        ip: string;
        state: 'ok' | 'black';
        ms: number | null;              // TLS 握手耗时（D13 C 档）
        error?: string;                 // 黑洞原因：timeout / cert / refused
      }>;
      nextRetryAt: number | null;       // degraded 时的下次重试时间
    }

### 6.6 面板（D13 C 档 / D18）

- 位置：`conversation.session.header.utilities`（与 mac-tunnel 同款挂载点）；
- 内容：一行小卡，显示 `IP 防护：N 个黑洞`；悬停展开每个 IP 的 state + 耗时；
- 「上次探测：X 分钟前」，由 `lastProbeAt` 与当前时间算得，每分钟刷新（D18）；
- 点击：POST `/opencode-ip-guard/refresh` → 重探 → 重建黑名单（D16）；
- 全失败/degraded 时显示黄色，代理禁用时显示灰色并注明原因；
- 整个组件 try/catch 包裹，任何异常只 console.warn，绝不影响会话渲染。

---

## 7. 边界情况与失败模式

| # | 场景 | 行为 |
|---|---|---|
| 1 | 探测全部超时（本地网络故障） | 黑名单不生效（全部放行）；state=degraded；60s→120s 重探，第三次失败放弃 |
| 2 | 过滤后一个 IP 都不剩 | 回退为原始列表，绝不把连接搞死 |
| 3 | DNS 解析失败 | 回退到 `dns.lookup`（系统解析器） |
| 4 | 运行期出现从没见过的新 IP | 本次放行 + 丢进后台探测队列（不阻塞请求） |
| 5 | 用户配了代理 | 插件自动禁用，面板提示（D11） |
| 6 | 用户运行中改了代理设置 | 本方案不感知；需重启 DSH。**已知限制，写入 README** |
| 7 | opencode 换 IP 池 | 本次运行内黑名单可能失效；重启后重新探测（D4 的代价） |
| 8 | 企业网络 TLS 中间人 | 探测证书校验失败 → 全部判黑洞 → 触发规则 1（全失败回退） |
| 9 | 插件自身抛异常 | apply 内全捕获，只 log，不拖垮 DSH |
| 10 | undici 版本差异 | 用 `dsh` 声明的依赖版本；启动时做一次能力检测，失败则禁用自己 |
| 11 | 只返回 IPv6 的网络 | `dns.resolve4` 空 → 回退到 `dns.lookup`（允许系统选择） |
| 12 | 探测期间有请求进来 | 黑名单为空 → 不过滤（等价原生），探测完成后自动生效 |

---

## 8. 与 DSH 的集成

### 8.1 包声明

    {
      "name": "dsh-opencode-ip-guard",
      "version": "0.1.0",
      "type": "module",
      "main": "src/index.js",
      "exports": { ".": "./src/index.js", "./client": "./src/client.js" },
      "dependencies": { "undici": "^7 || ^8" },
      "dsh": {
        "bundle": { "patch": "./cordis.patch.yml" },
        "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
      }
    }

### 8.2 cordis.patch.yml

    - insert:
        - id: opencode-ip-guard
          name: 'dsh-opencode-ip-guard'

### 8.3 安装

    # 方式一：npm
    cd ~/.dsh/profiles/desktop && pnpm add dsh-opencode-ip-guard

    # 方式二：tgz
    cd ~/.dsh/profiles/desktop && pnpm add file:./dsh-opencode-ip-guard-0.1.0.tgz

    # 方式三：本地 link（开发）
    pnpm add link:D:/path/to/opencode-ip-guard

然后在 profile 的 `package.json` 里把包名加进 `dsh.profile.bundles`，再在 profile 的 `cordis.patch.yml` 里按需覆盖 config。

### 8.4 配置项（全部可选）

    - id: opencode-ip-guard
      config:
        hostname: 'opencode.ai'      # 默认即此，一般不用改
        probeTimeoutMs: 10000        # 探测超时（D19，固定 10s）
        enabled: true                # 总开关
        forceIps: []                 # 测试钩子：强制只使用这些 IP（验收 3 用）

---

## 9. 测试计划

### 9.1 单元测试（不联网）

| 测试 | 断言 |
|---|---|
| `blacklist.filter` 剔除黑洞、保留可用 | 输入 4 个 IP + 2 个黑名单 → 输出 2 个 |
| `blacklist` 全部黑洞时 filter 返回原文 | 不返回空数组 |
| `lookup` 在 all 模式返回数组、非 all 模式返回单地址 | 两种回调签名都覆盖 |
| `lookup` 在 dns 解析失败时回退 `dns.lookup` | 用 mock 注入错误 |
| `probe` 对本地自签 TLS 服务器的成功/超时判定 | 用 node:tls 起本地服务器 |
| `guard` 代理检测：有/无/无效代理值 | 环境变量表驱动 |

### 9.2 集成测试（真实网络，可跳过）

- 真实解析 `opencode.ai`，探测 4 个 IP，断言至少 1 个 ok；
- 注入 dispatcher 后，用 `dns.lookup` 断点确认 lookup 被调用；
- 断言过滤后的地址集合不含黑名单 IP。

### 9.3 验收标准（写进 README，D20）

**验收 1 · 抓包**

    # 插件启用后，观察 TCP 连接的目标地址
    Get-NetTCPConnection -RemotePort 443 | Where-Object { $_.RemoteAddress -like '172.65.*' }
    # 期望：只出现可用 IP，不出现黑名单 IP

**验收 2 · 开关对比**

    插件关闭：连续 20 次请求，记录耗时分布（预期出现 20s+ 的尖峰）
    插件开启：同样 20 次，记录耗时分布（预期稳定在 1~2s）
    对比 p50 / p90 / 最大值

**验收 3 · 强制注入黑洞（阴性对照，最强）**

    # 用测试钩子强制把黑洞 IP 塞进候选，验证插件会自动绕开
    $env:OPENCODE_IP_GUARD_FORCE_IPS = '172.65.90.20'
    # 期望：若无插件 → 请求卡 10s 超时；有插件 → 自动改用可用 IP，请求正常

---

## 10. 已验证的技术前提（不是假设）

| 前提 | 验证方式 | 结论 |
|---|---|---|
| `connect.lookup` 能接管 DNS | 实验：强制返回 .21 / .20 | .21 → 200/728ms；.20 → 5568ms 超时 |
| 外部 undici Agent 能接管 Node 内置 fetch | 实验：setGlobalDispatcher + 空闲 5s | 复用生效，dispatch 被调用 |
| TLS 探测能区分可用/黑洞 | 实验：对 4 个 IP 做 TLS 握手 | 可用 348~371ms；黑洞 10s 超时 |
| IPv6 存在但可忽略 | 实验：resolve6 | 有 4 个 AAAA，但我们只 resolve4 |
| 插件机制（host+client） | 读 mac-tunnel 源码 | 结构、坑位、挂载点全部清楚 |

---

## 11. 已知风险与限制（必须写进 README）

1. **只对 `opencode.ai` 生效**（D14）；
2. **不持久化**：每次 DSH 启动重新探测（D4）；
3. **运行中改代理不会生效**，需重启 DSH；
4. **opencode 换 IP 池后**，本次运行内可能失效（重启恢复）；
5. **企业 TLS 中间人**会导致探测全失败 → 插件自动退化为不过滤；
6. 依赖 undici 的 `connect.lookup` 行为，若未来 undici 大版本变更需适配。

---

## 12. 发布（D15）

- GitHub：`<待定组织>/dsh-opencode-ip-guard`，`LICENSE` = Apache-2.0；
- npm：`dsh-opencode-ip-guard`；
- tgz：`npm pack` 产物作为离线安装包；
- README 必须有：问题背景（链到根因报告）、安装、验收三条、已知限制。

---

## 13. 待你确认的两处

1. **包名**：`dsh-opencode-ip-guard` 是否可接受？（也可叫 `opencode-ip-guard` / `dsh-blackhole-guard`）
2. **npm 发布 scope**：是否用 `@你的scope/...`？

*本方案中所有「已实测」结论均来自本机复现实验；未验证的部分已在第 11 节明确标注为风险。*