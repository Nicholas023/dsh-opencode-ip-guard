# 更新日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.1.0]

### 超时拆分（2026-10-29）
- `probeTimeoutMs` 默认由 10 秒改为 **4 秒**：可用 IP 实测 0.35~0.4 秒完成握手，10 秒只会拖慢黑洞判定。
- 新增 `connectTimeoutMs`（默认 10 秒）：undici 运行时建连超时与探测超时拆分为两个独立配置项。

### 抗干扰设计（实测反馈后追加）
- 黑名单条目增加**软过期时间**（`blacklistTtlMs`，默认 5 分钟）：IP 可达性会分钟级波动，单次探测的误判最多存活 TTL 后自动放行。
- 探测失败增加**二次确认**（`confirmDelayMs`，默认 2 秒）：连续两次失败才判黑洞，避免瞬时抖动被固化成永久坏。
- 过期补探：只有存在「过期且是黑洞」的条目时才触发重探，不产生周期性探测。 - 2026-10-29

首个发布版本：让 DSH 访问 `opencode.ai` 时永远不连接已知黑洞 IP。

### 新增

- **TLS 探测**：对每个 A 记录做 TCP + 完整 TLS 握手（SNI 与证书链校验），不发 HTTP 请求；
  握手成功记为可用并记录耗时，超时或失败记为黑洞（决策 D12/D17）。
- **内存黑名单**：`filter()` 剔除黑洞 IP，若剔除后为空则回退原始列表，避免把连接搞死；
  `rebuild()` 用一轮探测结果整体重建（决策 D2/D4/D16）。
- **undici lookup 钩子**：只对 `opencode.ai` 生效，`dns.resolve4` 实时解析、过滤黑名单、
  只返回 IPv4；解析失败时回退系统解析器，绝不阻断 DSH 的其它连接（决策 D14）。
- **全局 dispatcher 注入**：通过 `setGlobalDispatcher` 让 Node 内置 fetch 走本插件的
  `connect.lookup`；建连超时保持默认 10 秒，不做 keepAlive 保活（决策 D6/D7）。
- **代理自动禁用**：检测到 `HTTP(S)_PROXY` / `ALL_PROXY` 等环境变量时自动不注入 dispatcher，
  状态置 `disabled_by_proxy`，避免覆盖 DSH 自己的代理 dispatcher（决策 D11）。
- **异步启动与降级重试**：启动探测不阻塞 DSH；探测全失败时黑名单不生效（全部放行），
  按 60 秒、120 秒重试，第三次失败置 `failed` 并放弃（决策 D8/D9）。
- **状态接口**：`GET /opencode-ip-guard/status` 返回状态快照，`POST /opencode-ip-guard/refresh`
  触发重探并重建黑名单。
- **会话头面板**：显示「IP 防护：N 个黑洞」，悬停查看每个 IP 的状态与握手耗时，
  显示上次探测时间，点击刷新，60 秒轮询（决策 D10/D13 C 档/D18）。
- **文档**：中文主文档 `README.zh.md`、英文 `README.md`、三条验收手册 `docs/ACCEPTANCE.md`。
- **许可证**：Apache-2.0。
