# dsh-opencode-ip-guard

> 一个 DeepSeek Harness（DSH）插件：在 undici 的 DNS 解析环节剔除 `opencode.ai` 的恒黑洞 IP，
> 让 DSH 永远不去连接那两个必死的 A 记录。

[English](./README.md) | **简体中文**

---

## 它解决什么问题

`opencode.ai` 有 4 个 A 记录：`172.65.90.20`、`.21`、`.22`、`.23`。其中 `.20` 与 `.22`
恒为黑洞：TCP 443 建连永不回应，Windows 要耗尽 SYN 重传约 21 秒才会放弃。

DSH 的模型请求走 Node 内置 fetch（undici 全局 dispatcher），默认**建连超时 10 秒**。
所以只要 DNS 返回顺序把黑洞 IP 排在同一次连接的最前面，DSH 就会在 10 秒后失败，
再由 llm-retry 退避重试最多 5 次 —— 最坏情况 74~78 秒没有任何模型输出，看起来就是「卡死」。

本插件先接管 undici 的 `connect.lookup`，再在后台对每个 A 记录做一次 TLS 握手探测，
把超时/失败的 IP 记进内存黑名单；之后对 `opencode.ai` 的每次解析都会剔除黑名单 IP，
只返回一个可用的 IPv4。DSH 从此只会连 `.21` / `.23`。

- 完整根因与实测数据：[根因报告](docs/planning/DSH-opencode-长连接失效根因报告.md)
- 模块接口与实现边界：[接口契约](docs/CONTRACTS.md)
- 逐条设计决策（D1~D20）：[决策记录](docs/planning/grill-决策记录.md)

---

## 工作原理（30 秒版）

1. 插件挂载后先安装一个自定义 undici Agent 作为全局 dispatcher，把 `connect.lookup` 换成过滤函数。
   此时黑名单还是空的（等于不过滤），所以「先接管、后探测」的顺序不会影响任何请求。
2. 随后**异步**探测（不阻塞 DSH 启动）：解析 `opencode.ai` 的全部 A 记录，
   对每个 IP 做 **TCP + 完整 TLS 握手**（SNI = `opencode.ai`、校验证书链、10 秒超时），**不发任何 HTTP 请求**。
3. 握手成功 = 可用（记录握手耗时）；超时或失败 = 黑洞。
4. 之后每次 DSH 访问 `opencode.ai`：`dns.resolve4` 实时解析 → 剔除黑名单 → 返回第一个可用 IPv4。
   解析失败时回退系统解析器；过滤后一个都不剩时回退原始列表 —— 这两条兜底保证「插件自己坏了也不会让 DSH 断网」。
5. 探测**全部失败**（例如本地网络故障）：黑名单不生效（等于原生行为），60 秒后重探，
   仍失败再等 120 秒重探，第三次失败后放弃（state=`failed`）。
6. 检测到用户配置了代理：插件**自动禁用自己**，不覆盖 DSH 的代理 dispatcher（state=`disabled_by_proxy`）；
   但如果 `NO_PROXY` 明确覆盖了 `opencode.ai`（流量本来就不走代理），插件照常生效。

明确**不做**的事：不改 hosts、不改系统 DNS、不做连接保活、默认不改建连超时（10 秒）、不持久化任何状态、不碰 DSH 业务代码。
探测只在「启动 / 降级重试 / 用户点击刷新」时发生，不会周期性打扰远端。

---

## 安装

**前置条件**

- DSH 已能正常启动（插件运行在 DSH 进程内，不需要另外装 Node）。
- DSH 自带的 Node ≥ 22.19.0（当前发行版为 Node 24.x，满足）。
- 没有配置 HTTP(S) 代理：走代理的用户不需要本插件，而且插件检测到代理会自动禁用（见「已知限制」）。

以下命令以 PowerShell 为例，profile 目录默认是 `$env:USERPROFILE\.dsh\profiles\desktop`。

### 方式一：npm（包发布到 npm 之后）

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add dsh-opencode-ip-guard
```

### 方式二：tgz（离线包 / 内部分发）

```powershell
# 在插件仓库根目录打包（产物是 dsh-opencode-ip-guard-0.1.0.tgz）
pnpm pack

# 再装进 profile
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "file:D:\path\to\dsh-opencode-ip-guard-0.1.0.tgz"
```

### 方式三：本地 link（开发调试）

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "link:D:\DSH-Files-v2\02-DSH开发\dshapi长连接插件"
```

### 最后一步：注册 bundle 并重启 DSH

编辑 profile 的 `package.json`，把包名加入 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "mac-tunnel",
        "dsh-opencode-ip-guard"
      ]
    }
  }
}
```

然后**完全退出 DSH 再启动**。Host 插件在进程启动时加载、client 面板随 Web GUI 一起加载；
热重载只对配置生效，新装包或改代码都必须重启。

---

## 配置

全部可选。写在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: opencode-ip-guard
  config:
    hostname: 'opencode.ai'       # 要防护的域名
    probeTimeoutMs: 10000         # 单个 IP 的 TLS 握手超时（毫秒）
    enabled: true                 # 总开关
    forceIps: []                  # 测试钩子：非空时忽略真实解析，只用这些 IP
    retryDelaysMs: [60000, 120000] # 探测全失败后的重试间隔（毫秒）
    blacklistTtlMs: 300000        # 黑名单条目的软过期时间（毫秒）
    confirmDelayMs: 2000          # 探测失败后的二次确认间隔（毫秒）
    expiryCheckIntervalMs: 30000  # 检查"是否有条目过期"的间隔（毫秒）
```

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `hostname` | string | `'opencode.ai'` | 需要防护的域名。只防这一个域名是刻意的设计，不做通用 IP 优选。 |
| `probeTimeoutMs` | number | `10000` | 单个 IP 的 TLS 握手超时；同时被用作 undici 的建连超时（两者刻意共用同一个值，默认 10 秒与 DSH 运行时口径一致）。所有 IP 并发探测，所以一轮探测总耗时约等于这个值。 |
| `enabled` | boolean | `true` | 总开关。设为 `false` 时插件不探测、不注入 dispatcher（等价于没装）。 |
| `forceIps` | string[] | `[]` | 测试钩子：非空时忽略真实 DNS 解析，只在这些 IP 里过滤挑选。用于验收 3 的阴性对照。 |
| `retryDelaysMs` | number[] | `[60000, 120000]` | 探测全失败后的重试间隔序列。数组走完仍失败则置 `failed` 并放弃。 |
| `blacklistTtlMs` | number | `300000` | **软过期时间**。opencode.ai 某些 IP 的可达性会分钟级波动，单次探测必然有误判；条目到期自动视为可用，让误判最多存活这么久。 |
| `confirmDelayMs` | number | `2000` | **失败二次确认间隔**。探测失败的 IP 隔这么久再试一次，**连续两次失败才判黑洞**，避免瞬时抖动被固化成「永久坏」。 |
| `expiryCheckIntervalMs` | number | `30000` | 检查过期条目的节拍。注意这不是周期性探测：只有存在「过期且是黑洞」的条目时才会触发重探。 |

**取值校验**（非法值一律回退默认值并打一条 warn，绝不抛错、绝不影响 DSH 启动）：

- `probeTimeoutMs` 会被夹到 2000~30000 毫秒之间；
- `retryDelaysMs` 只接受非负有限数，过滤后为空则回默认；
- `forceIps` 只接受合法 IPv4 字面量；
- `hostname` 需为非空字符串（会 trim 并转小写）；
- `enabled` 只认布尔值；
- `blacklistTtlMs` 夹到 10000~3600000 毫秒；
- `confirmDelayMs` 夹到 100~10000 毫秒；
- `expiryCheckIntervalMs` 夹到 5000~600000 毫秒。

### 为什么需要「软过期 + 二次确认」

实测发现 opencode.ai 的 A 记录集合是稳定的（1 小时内恒为 4 个），但其中某些 IP 的**可达性会波动**：同一 IP 可能这小时通、下小时不通。如果探测只做一次快照：

- 一次瞬时抖动就会把好 IP 判成「永久黑洞」，本次运行内不再使用；
- 极端情况下 4 个 IP 轮流被冤枉 → 全部拉黑 → 触发「全黑回退」→ 插件等于失效。

所以加了两层保险：

1. **失败二次确认**（`confirmDelayMs`）：首轮失败的 IP 隔 2 秒再探一次，连续两次失败才拉黑；
2. **软 TTL**（`blacklistTtlMs`）：即使真的拉黑了，5 分钟后自动过期放行，并触发一次补探更新结论。

两者都不会产生周期性探测，符合「不打扰远端」的原则。

---

## 面板与状态接口

插件启用后，对话会话头会出现一张小卡片（与 mac-tunnel 同款挂载点）：

- 平时显示「**IP 防护：N 个黑洞**」；
- 悬停展开每个 IP：`state`（ok / black）与 TLS 握手耗时；
- 显示「上次探测：X 分钟前」，由 host 记录的时间戳换算，每分钟刷新；
- 点击卡片 → `POST /opencode-ip-guard/refresh` → 立即重探并用新结果**重建**黑名单（恢复的 IP 会被移出）；
- 每 60 秒自动拉取一次状态；
- 颜色语义：就绪为绿色，探测中/降级为黄色，失败/异常为红色，因代理禁用或配置关闭为灰色（tooltip 里写明原因）。

Host 侧同时开放两个只读/触发路由（端口与 DSH Web GUI 相同）：

```powershell
# 查看状态快照
Invoke-RestMethod "http://127.0.0.1:<DSH端口>/opencode-ip-guard/status" | ConvertTo-Json -Depth 6

# 触发重探并重建黑名单
Invoke-RestMethod -Method Post "http://127.0.0.1:<DSH端口>/opencode-ip-guard/refresh" | ConvertTo-Json -Depth 6
```

`state` 的取值与含义：

| state | 含义 |
|---|---|
| `idle` | 尚未开始探测（或配置里 `enabled: false`） |
| `probing` | 正在探测 |
| `ready` | 探测完成，黑名单已生效 |
| `degraded` | 探测全失败，暂时不过滤，正在按 `retryDelaysMs` 重试 |
| `failed` | 重试次数用尽，已放弃（本次运行内不再过滤） |
| `disabled_by_proxy` | 检测到代理配置，插件主动禁用 |
| `error` | 插件内部异常，已降级 |

---

## 三条验收

完整步骤、预期结果与失败判读见 **[验收手册 docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)**。这里是速查版。

### 验收 1 · 抓包（确认连接目标里没有黑洞 IP）

```powershell
# 在 DSH 里触发一次模型请求，然后采样 443 连接的目标地址
1..20 | ForEach-Object {
  Get-NetTCPConnection -RemotePort 443 -ErrorAction SilentlyContinue |
    Where-Object { $_.RemoteAddress -like '172.65.*' } |
    Select-Object -ExpandProperty RemoteAddress
  Start-Sleep -Milliseconds 500
} | Sort-Object -Unique
```

**期望**：只出现 `172.65.90.21` / `172.65.90.23`，不出现 `.20` / `.22`。

### 验收 2 · 开关对比（耗时分布）

插件开启时 20 次请求耗时稳定在 1~2 秒；关闭插件时同一批次可能出现 10 秒以上的尖峰（命中黑洞后建连超时）。
对比 p50 / p90 / 最大值。注意：本插件只接管 **DSH 进程内**的 undici，`curl.exe` 不经过插件，
所以对比必须在 Node fetch 路径上做。把 [验收手册](docs/ACCEPTANCE.md) 里的 `acceptance-2.mjs`
保存到仓库根目录后，直接跑：

```powershell
# 插件关闭组的基线（等价原生行为）
node acceptance-2.mjs off 20
# 插件开启组（进程内安装过滤后的 dispatcher）
node acceptance-2.mjs on 20
```

### 验收 3 · 强制注入黑洞（阴性对照，最强）

把黑洞 IP 强制塞进候选，验证插件会自动绕开：

```yaml
# 写进 profile 的 cordis.patch.yml 后重启 DSH
- id: opencode-ip-guard
  config:
    forceIps: ['172.65.90.20', '172.65.90.21']
```

**期望**：请求正常、耗时约 1 秒，连接目标只出现 `.21`；对照实验里 `curl.exe --resolve` 直连 `.20`
则应该 10 秒超时。

> 注意：`forceIps` 必须包含至少一个可用 IP。若只放黑洞 IP，过滤后会为空、按契约回退原始列表，
> 结果仍然是连黑洞 —— 这是「绝不把连接搞死」的保护，不是 bug。

---

## 已知限制

1. **只对 `opencode.ai` 生效。** 插件不做通用 IP 优选；换域名请改 `hostname` 配置，但探测/证书校验逻辑按该域名工作。
2. **不持久化。** 黑名单只活在本次 DSH 运行期，每次启动重新探测；重启后到探测完成前的窗口内不过滤（等价原生行为）。
3. **运行中修改代理设置不会生效。** 代理检测只在启动时做一次，改完必须重启 DSH。
4. **opencode 更换 IP 池后可能失效。** 本次运行内的黑名单按当时解析到的 IP 判定；遇到新 IP 会放行（不阻断），
   但旧黑洞判定可能对不上，重启 DSH 重新探测即可。
5. **企业网络 TLS 中间人会导致自动降级。** 探测做完整证书链校验，中间人证书会让所有 IP 都失败 →
   触发「全失败回退」，插件退化为不过滤，并在面板/状态里显示 `degraded` 或 `failed`。
6. **依赖 undici 的 `connect.lookup` 行为。** 当前针对 undici 8.x（`^8.11.2`）验证；
   若未来 undici 大版本改变 lookup 契约，需要适配本插件。插件启动时会做一次能力检测，缺失所需 API 就放弃接管（降级为不过滤）。
7. **不解决「空闲连接被回收」。** 本插件不做 keepAlive（刻意的决策），只解决「连到黑洞 IP」；
   空闲约 3 秒后连接被回收、下次请求重新握手，属于另一条优化路径。
8. **只影响 Node 内置 fetch / undici 路径。** `curl`、浏览器或其它非 undici 的 HTTP 客户端不经过本插件。
9. **只用 IPv4（`dns.resolve4`）。** 纯 IPv6 网络下解析结果为空时会回退系统解析器，此时过滤不生效。
10. **探测需要真实的 443 出站。** 若本机被防火墙拦截 TLS，探测全失败 → 退化为不过滤。

---

## 与其它插件的共存

- **代理类插件 / DSH 自带的 `installProxyFromEnvironment()`**：检测到代理时本插件**不注入** dispatcher，
  所以不会覆盖代理链路；代价是此时本插件不生效（走代理本就不需要它）。这是有意的取舍：宁可不生效，也不破坏代理。
  例外：若 `NO_PROXY` 已覆盖 `opencode.ai`，说明这条流量本来就不走代理，本插件会照常接管。
- **其它会调用 `setGlobalDispatcher` 的插件**：全局 dispatcher 只能有一个，后安装者生效。
  请不要同时启用两个都改全局 dispatcher 的插件 —— 不会崩，但其中一个会静默失效。
- **mac-tunnel**：工作在不同的层（SSH 端口转发）且不经过 undici，两者不冲突；本插件也不会干预
  mac-tunnel 的 ssh 连接。
- **面板类插件**（如 dsh-ops、dsh-phone 等）：挂载点互不重叠，互不影响。
- 本插件不改 profile 的其它配置、不写任何文件、不联网上报数据。

---

## 开发与测试

仓库结构见 [实现方案 §4](docs/planning/实现方案-黑洞IP过滤插件.md)。

```powershell
# 单元测试（不联网的用例应能在无网络环境跑过）
node --test "test/*.test.mjs"

# 说明：不要直接写 node --test（Node 24 的自动发现会把 scripts/acceptance.mjs
# 这个手工验收脚本也当成测试跑，它会真的发网络请求并长时间挂住），
# 也不要写 node --test test/（Node 24 会把目录参数当成模块路径而报 MODULE_NOT_FOUND）。
```

唯一运行时依赖是 `undici`（`^8.11.2`），除它之外不引入任何第三方依赖。

---

## 许可证

[Apache License 2.0](./LICENSE)，Copyright 2026 Nicholas023。

你可以自由使用、修改、分发本插件（包括商用），但需保留许可证与版权声明；本插件不提供任何担保。
