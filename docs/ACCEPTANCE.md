# 验收手册 · dsh-opencode-ip-guard

> 本手册把方案 §9.3 的三条验收写成可复制、可判读的完整步骤。
> 每条验收都给出「前置条件 → 步骤 → 预期结果 → 失败判读」，照着做就能得出「插件到底生效没有」的结论。
>
> 依据：`docs/planning/实现方案-黑洞IP过滤插件.md` §9.3、`docs/planning/grill-决策记录.md` D17/D19/D20。
> 接口与行为以 `docs/CONTRACTS.md` 为准；本手册不引入契约之外的行为。

---

## 0. 通用准备

### 0.1 判定原则（控制变量法）

- **一次只改一个变量**：每次只切换「插件开 / 关」「forceIps 有 / 无」「代理有 / 无」中的一个，其余保持不动；
- **每条结论都要有对照**：只有「插件关闭 → 出现 10 秒尖峰」和「插件开启 → 没有尖峰」同时成立，才能说插件有效；
- **先看状态再测行为**：状态接口说没就绪，就不用往下测了（先排查探测）；
- **记录时间与版本**：网络状况会变，每条结论都要带上时间戳和 undici 版本（附录 C 有记录表）。

### 0.2 环境自检

在 PowerShell 里执行：

```powershell
# 1) 确认没有代理环境变量：有值的话插件会主动禁用自己（state=disabled_by_proxy），这是预期行为而不是故障
#    例外：若 NO_PROXY 已覆盖 opencode.ai（这条流量本来就不走代理），插件会照常生效。
Get-ChildItem Env: |
  Where-Object { $_.Name -match '^(HTTP|HTTPS|ALL|NO)_PROXY$' } |
  Format-Table Name, Value -AutoSize

# 2) 确认 opencode.ai 当前的 A 记录（黑洞判定以实际探测为准，IP 可能变化）
Resolve-DnsName opencode.ai -Type A | Where-Object { $_.Type -eq 'A' } | Select-Object Name, IPAddress

# 3) 找到 DSH Web GUI 端口（浏览器地址栏 http://127.0.0.1:<端口> 里的那个数字）
$port = 57643   # <-- 改成你自己的端口
$base = "http://127.0.0.1:$port"
```

### 0.3 变量约定

```powershell
# Node 可执行文件：若 node 已在 PATH 上可直接用 "node"
$node = "node"
# 本机没有独立 Node 时，用 DSH 自带的那个（只读执行，不写部署目录）
# $node = "D:\deepseek_harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

# 插件仓库根（本手册里的脚本都放在这里跑）
$repo = "D:\DSH-Files-v2\02-DSH开发\dshapi长连接插件"

# 黑洞 IP / 可用 IP（以 0.2 第 2 步的实际解析结果为准；本文按 2026-10 本机实测填写）
$blackIp = '172.65.90.20'
$goodIp  = '172.65.90.21'

# 状态接口
$statusUrl  = "$base/opencode-ip-guard/status"
$refreshUrl = "$base/opencode-ip-guard/refresh"
```

### 0.4 验收前的就绪检查（三条验收的共同前置）

```powershell
# 期望：state=ready，entries 里既有 ok 也有 black，stats.total >= 2
Invoke-RestMethod $statusUrl | ConvertTo-Json -Depth 6
```

预期形状：

```json
{
  "state": "ready",
  "enabled": true,
  "reason": null,
  "lastProbeAt": 1761724800000,
  "nextRetryAt": null,
  "entries": [
    { "ip": "172.65.90.20", "state": "black", "ms": null, "error": "timeout", "at": 1761724800000 },
    { "ip": "172.65.90.21", "state": "ok", "ms": 371, "error": null, "at": 1761724800000 },
    { "ip": "172.65.90.22", "state": "black", "ms": null, "error": "timeout", "at": 1761724800000 },
    { "ip": "172.65.90.23", "state": "ok", "ms": 348, "error": null, "at": 1761724800000 }
  ],
  "stats": { "ok": 2, "black": 2, "total": 4 }
}
```

- `state` 必须是 `ready` 才有资格做验收 1/2/3 的「插件开启」组；
- 若 `state` 是 `disabled_by_proxy`：先按 0.2 第 1 步确认代理变量，清掉后重启 DSH
  （`NO_PROXY` 覆盖 `opencode.ai` 时不会进入这个状态，属于正常生效）；
- 若 `state` 是 `degraded` / `failed` / `error`：先排查网络与证书（企业 TLS 中间人会让全部探测失败，见「已知限制」5）。

---

## 验收 1 · 抓包（确认 DSH 的 TCP 只连可用 IP）

**要证明的事**：插件生效后，DSH 对 `opencode.ai` 建立的每条 443 连接，远端地址都不在黑名单里。

### 步骤

1. 打开 DSH 会话，准备连续发 5~10 条消息（每条都会触发一次模型请求，请求间隔越分散越好）。
2. 另开一个 PowerShell 窗口，运行下面这段采样脚本（采样 90 秒）：

```powershell
$deadline = (Get-Date).AddSeconds(90)
$seen = @{}
while ((Get-Date) -lt $deadline) {
  Get-NetTCPConnection -RemotePort 443 -ErrorAction SilentlyContinue |
    Where-Object { $_.RemoteAddress -like '172.65.*' } |
    ForEach-Object { $seen[$_.RemoteAddress] = $true }
  Start-Sleep -Milliseconds 300
}
Write-Output "本次采样到的远端地址："
$seen.Keys | Sort-Object
```

3. 在采样期间回到 DSH，把那 5~10 条消息发完。

### 预期结果

- 采样结果**只包含** `172.65.90.21`、`172.65.90.23`（即状态里 `state=ok` 的那些 IP）；
- **不出现** `172.65.90.20` / `172.65.90.22`。

### 失败判读

| 现象 | 含义 | 下一步 |
|---|---|---|
| 出现 `.20` / `.22` | 过滤没生效：lookup 没被调用，或黑名单里没有该 IP | 看 `/status` 的 entries 是否把该 IP 标为 black；再看 state 是否 ready |
| 一条地址都没采样到 | 采样窗口没覆盖到建连瞬间（DSH 请求稀疏，连接空闲约 3 秒就被回收） | 把采样窗口延长到 180 秒，或把消息发得密集一些 |
| 采样到 `.21`/`.23`，但请求仍然慢 | 慢的原因不在建连（可能是服务端 429/502 或模型生成慢） | 看 DSH 日志里的 retry 事件；这条验收只对「连接目标」负责 |
| `/status` 404 | webServer 路由不可用（插件本身可能仍在工作，只是没有面板数据源） | 用验收 2 直接验证行为；面板问题另行排查 |
| `Get-NetTCPConnection` 报拒绝访问 | 需要提升权限 | 用管理员 PowerShell 重跑 |

> 对照实验（可选，但推荐）：临时把插件关掉（`enabled: false`）或从 bundles 移除并重启，
> 重复上述采样，多跑几轮应当能抓到 `.20` / `.22`。有对照才能排除「本来就是 DNS 没给黑洞 IP」的巧合。

---

## 验收 2 · 开关对比（耗时分布）

**要证明的事**：插件开启时不再出现「建连 10 秒超时」的尖峰，耗时分布整体下移且尾部被削掉。

### 为什么必须用 Node 跑，而不能用 curl

本插件接管的是 **DSH 进程内 undici 的全局 dispatcher**。`curl.exe`、浏览器都不经过 undici，
所以用 curl 测只能测到裸网络，**永远测不出插件效果**。下面的脚本在独立 Node 进程里复现
DSH 的同一条路径：全局 dispatcher + 自定义 lookup + Node 内置 fetch。

### 脚本

把下面内容保存为仓库根目录的 `acceptance-2.mjs`（**用完请删除**，不要提交）：

```js
// 验收 2：插件开/关的 20 次请求耗时对比。
// 用法：node acceptance-2.mjs off   或   node acceptance-2.mjs on [轮数]
// 为什么每次请求之间要空闲 5 秒：undici 默认保活窗口约 3 秒，
// 间隔大于它才能保证每次都重新建连，从而暴露「命中黑洞 → 10 秒超时」这条路径。
import { promises as dns } from 'node:dns';

const mode = process.argv[2] === 'on' ? 'on' : 'off';
const rounds = Number(process.argv[3] ?? 20);
const host = 'opencode.ai';
const url = 'https://opencode.ai/';
const idleMs = 5000;

let restore = () => {};
if (mode === 'on') {
  const { createBlacklist } = await import('./src/blacklist.js');
  const { probeAll } = await import('./src/probe.js');
  const { createLookup } = await import('./src/lookup.js');
  const { installDispatcher } = await import('./src/dispatcher.js');

  const ips = await dns.resolve4(host);
  const results = await probeAll(ips, { servername: host, timeoutMs: 10000 });
  const blacklist = createBlacklist();
  blacklist.rebuild(results);
  const lookup = createLookup({ hostnames: [host], blacklist });
  ({ restore } = await installDispatcher({ lookup, connectTimeoutMs: 10000 }));

  console.log('# 探测结果：' + results.map((r) => r.ip + '=' + (r.ok ? 'ok' : 'black')).join(' '));
  console.log('# 过滤后候选：' + blacklist.filter(ips).join(', '));
}

const samples = [];
for (let i = 1; i <= rounds; i++) {
  const t0 = performance.now();
  let outcome = 'ok';
  try {
    // 只关心能不能建连成功，HTTP 状态码（404/403 等）不算失败
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(40000) });
  } catch (err) {
    outcome = err?.cause?.code ?? err?.name ?? 'unknown';
  }
  const ms = Math.round(performance.now() - t0);
  samples.push({ ms, outcome });
  console.log(`# ${i}/${rounds} ${ms}ms ${outcome}`);
  await new Promise((r) => setTimeout(r, idleMs));
}
restore();

const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
const pick = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
console.log(JSON.stringify({
  mode,
  rounds,
  p50: pick(50),
  p90: pick(90),
  max: sorted[sorted.length - 1],
  over10s: samples.filter((s) => s.ms >= 10000).length,
  failures: samples.filter((s) => s.outcome !== 'ok').map((s) => s.outcome),
}, null, 2));
```

### 步骤

```powershell
cd $repo

# 插件关闭组（等价于插件未安装时的原生行为）
& $node acceptance-2.mjs off 20

# 插件开启组（进程内装 dispatcher + 过滤后的 lookup）
& $node acceptance-2.mjs on 20
```

> 每组约 20 × (5 秒空闲 + 请求耗时) ≈ 2~4 分钟。为避免网络抖动干扰，建议每组至少跑 2 轮，
> 并交错执行（off, on, off, on），而不是先连跑两轮 off 再连跑两轮 on。

### 预期结果

| 指标 | 插件关闭（off） | 插件开启（on） |
|---|---|---|
| p50 | 0.8~2 s（命中可用 IP 时）| 0.8~2 s |
| max | **≥ 10 s**（命中黑洞，`UND_ERR_CONNECT_TIMEOUT`） | **< 3 s** |
| `over10s` | 0~若干次（取决于 DNS 顺序） | **0** |
| `failures` | 可能包含 `UND_ERR_CONNECT_TIMEOUT` 等 | 应只有 `ok`（HTTP 错误码不算失败） |

### 失败判读

| 现象 | 含义 | 下一步 |
|---|---|---|
| off 组也没出现 ≥10 秒 | 这一轮刚好没命中黑洞（DNS 随机顺序），或内核/运行时自行切换了地址 | 加大轮数（如 40）或重跑几轮；不要因此判定「黑洞不存在」 |
| on 组仍有 ≥10 秒 | 过滤没生效：lookup 没被调用或黑名单为空 | 看脚本前两行输出了什么：`过滤后候选` 若仍含黑洞 IP，说明探测/标记有问题 |
| on 组有些失败但不是超时 | 服务端限流/网络抖动 | 看 `failures` 内容；`UND_ERR_SOCKET` 之类的偶发要结合当时网络判断 |
| 两组差别不明显 | 本机当前链路对黑洞 IP 本来就能快速失败/切换 | 改用验收 3（强制注入）做确定性验证 |

> 说明：本机实测中 undici 有时能通过自动地址切换（autoSelectFamily）绕开黑洞，
> 所以验收 2 的「off 组」不保证每轮都出现尖峰。**验收 3 才是确定性最强的那一条。**

---

## 验收 3 · 强制注入黑洞（阴性对照，最强）

**要证明的事**：即使把黑洞 IP 强制塞进候选列表的最前面，插件也会自动改连可用 IP；
而同一环境下的裸连接（不经过插件）会以 10 秒超时收场。

### 第一段：确认 `.20` 确实是黑洞（不经过插件，纯网络对照）

```powershell
# 黑洞 IP：期望 curl 退出码 28、http=000、total 约等于 --connect-timeout 的值
curl.exe --resolve opencode.ai:443:$blackIp --connect-timeout 10 -s -o NUL `
  -w "black: http=%{http_code} connect=%{time_connect} total=%{time_total}\n" https://opencode.ai/
Write-Output "curl exit code = $LASTEXITCODE"

# 可用 IP 对照：期望 http=200/3xx、connect 约 0.2 s
curl.exe --resolve opencode.ai:443:$goodIp --connect-timeout 10 -s -o NUL `
  -w "good : http=%{http_code} connect=%{time_connect} total=%{time_total}\n" https://opencode.ai/
Write-Output "curl exit code = $LASTEXITCODE"
```

**预期**：黑洞 IP 输出 `http=000`、`total≈10.0`、退出码 `28`；可用 IP 输出 `http=200`（或 3xx）、
`connect≈0.2`、退出码 `0`。这一步不涉及插件，是对「黑洞存在」这个前提的独立复核。

### 第二段：让插件强制只从「黑洞 + 可用」里挑

编辑 profile 的 `cordis.patch.yml`（`$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml`），
在末尾追加：

```yaml
# 验收 3：把黑洞 IP 排在候选列表最前面，验证插件会跳过它
- id: opencode-ip-guard
  config:
    forceIps: ['172.65.90.20', '172.65.90.21']
```

然后**完全退出并重启 DSH**（config 覆盖在进程启动时读取）。

重启后：

```powershell
# 1) 状态应仍是 ready，entries 里应能看 .20 为 black、.21 为 ok
Invoke-RestMethod $statusUrl | ConvertTo-Json -Depth 6

# 2) 在 DSH 里发一条消息，同时用验收 1 的采样脚本观察远端地址
1..200 | ForEach-Object {
  Get-NetTCPConnection -RemotePort 443 -ErrorAction SilentlyContinue |
    Where-Object { $_.RemoteAddress -like '172.65.*' } |
    Select-Object -ExpandProperty RemoteAddress
  Start-Sleep -Milliseconds 300
} | Sort-Object -Unique
```

### 预期结果

- 请求正常完成，耗时约 1~2 秒（不是 10 秒）；
- 采样到的远端地址**只有 `172.65.90.21`**（因为 `forceIps` 里只有 `.20` 和 `.21`），**没有 `.20`**；
- `/status` 中 `.20` 的 `state` 为 `black`。

### 失败判读

| 现象 | 含义 | 下一步 |
|---|---|---|
| 请求卡约 10 秒后失败 | lookup 没接管（还是默认 dispatcher）或黑名单为空 | 查 `/status`；查是否还有其它插件覆盖了全局 dispatcher；确认 DSH 已重启 |
| 采样到 `.20` | `forceIps` 未生效，或过滤逻辑没剔除它 | 确认 `forceIps` 拼写、profile 是否被正确加载、`/status` 里 `.20` 是否 black |
| 请求直接连 `.20` 并超时 | `forceIps` 里**没有可用 IP**，过滤后为空 → 按契约回退原始列表 | 这是保护行为不是 bug；`forceIps` 必须至少包含一个可用 IP |
| `/status` 里根本没有 `.20` 这一条 | 探测没跑到它（DNS 集合变化） | 以当前实际解析结果为准，改 `forceIps` 为当前黑洞 IP |

### 第三段：清理

```powershell
# 1) 从 profile 的 cordis.patch.yml 里删掉上面那段 forceIps 配置
# 2) 完全退出并重启 DSH
# 3) 确认状态恢复默认（应只防护真实解析结果）
Invoke-RestMethod $statusUrl | ConvertTo-Json -Depth 6
```

> 若暂时不想改 profile，也可以只把 `enabled` 设为 `false` 重启，恢复到「插件不生效」的原生状态。

---

## 附录 A · 状态接口与刷新自检

```powershell
# 状态
Invoke-RestMethod $statusUrl | ConvertTo-Json -Depth 6

# 点击刷新（等价于面板点击）：重探并重建黑名单
Invoke-RestMethod -Method Post $refreshUrl | ConvertTo-Json -Depth 6
```

自检要点：

- `refresh` 之后 `lastProbeAt` 必须变大，且 `entries[].at` 更新；
- 恢复的 IP 会从 `black` 变回 `ok`（重建而非累加，这是 D16 的行为）；
- `state` 为 `degraded` 时 `nextRetryAt` 应是一个未来时间戳（上次重试时刻 + `retryDelaysMs` 的下一档）；
- 以下两种情况 `refresh` 会直接返回当前快照而不重探，属于设计行为、不算失败：
  已经有探测在进行（本轮请求被合并）、或者插件处于 `idle` / `disabled_by_proxy` / `enabled: false` 的禁用态。

## 附录 B · 失败现象 → 排查方向速查

| 现象 | 最可能的原因 | 先查什么 |
|---|---|---|
| `/status` 连不上 / 404 | webServer 不可用或路由未注册 | 端口是否正确；插件是否真的加载（进程启动日志） |
| state 一直是 `idle` | 探测没启动 | 是否 `enabled: false`；插件是否挂在 bundles 里 |
| state `disabled_by_proxy` | 检测到代理环境变量 | 0.2 第 1 步；清掉代理后重启 |
| state `degraded` / `failed` | 探测全失败（网络/证书/防火墙） | 用验收 3 第一段确认 curl 能否握手；企业 TLS 中间人见已知限制 5 |
| state `ready` 但耗时仍有 10 秒尖峰 | 过滤未接管连接（其它 dispatcher 覆盖） | 是否同时启用了别的改全局 dispatcher 的插件 |
| 面板不出现 | client bundle 未加载 | 是否重启过 DSH；bundles 是否包含包名 |
| 面板数字长期不更新 | 轮询/接口异常 | 手动点一下刷新，看 `/refresh` 是否报错 |

## 附录 C · 验收记录表（每次验收请填）

| 项 | 值 |
|---|---|
| 日期时间 | |
| DSH 版本 / Node 版本 | |
| undici 版本 | |
| 插件版本 | |
| profile 路径 | |
| 是否配置代理 | |
| 当时 `opencode.ai` 的 A 记录 | |
| `/status` 的 state | |
| 验收 1 采样结果（远端地址集合） | |
| 验收 2 p50 / p90 / max（off） | |
| 验收 2 p50 / p90 / max（on） | |
| 验收 3 是否命中 `.20` / 耗时 | |
| 结论（通过 / 不通过 + 原因） | |
