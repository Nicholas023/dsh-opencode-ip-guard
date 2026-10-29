## 这个版本解决什么问题

DSH 调用 opencode.ai 时经常出现「单次调用 20 秒以上、界面长时间无输出、最后掉线」。
根因不是模型慢，而是：

1. `opencode.ai` 的 4 个 A 记录里**存在黑洞 IP**——命中时 TCP SYN 一直重传，Windows 要约 21 秒才失败；
2. DSH 走 Node 内置 fetch（undici），**默认建连超时只有 10 秒**，等不到 21 秒就放弃；
3. 失败后按默认策略重试 5 次，每次又付一次 10 秒 → 约 75 秒无输出 → 用户以为卡死；
4. 即使连上，undici 默认空闲连接约 3 秒回收，而真实请求间隔 p50 是 12.98 秒（92.8% > 4 秒）→ 几乎每次请求都重新握手。

更麻烦的是：IP 的**可达性会波动**（同一 IP 可能这小时通、下小时不通），所以不能靠 hosts 固定。

## 这个版本做了什么

- **接入 undici 的 `connect.lookup`**，在每次 DNS 解析时剔除已知黑洞 IP，只返回 IPv4；
- **异步 TLS 探测**（TCP + 完整 TLS 握手 + 证书校验，不发 HTTP 请求），启动时不阻塞 DSH；
- **失败二次确认**：连续两次失败才判黑洞，避免瞬时抖动被固化成「永久坏」；
- **黑名单软过期（5 分钟）**：误判最多存活 5 分钟，到期自动放行并触发补探；
- **全失败自动回退**：4 个 IP 全被判黑洞时不过滤，绝不把连接搞死；
- **代理自动禁用**：检测到 HTTP(S) 代理时主动让位，不覆盖 DSH 自己的代理 dispatcher；
- **会话头状态小卡**：显示黑洞数量与每个 IP 的探测耗时，点一下即可重探。

## 安装

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add dsh-opencode-ip-guard
```

然后把 `dsh-opencode-ip-guard` 加入 profile 的 `package.json` 的 `dsh.profile.bundles`，重启 DSH。
详细步骤见 README。

## 验证

- 单元测试 93 项 / 集成冒烟 7 项 / 验收 7 项，全部通过；
- 真实环境确认：`/opencode-ip-guard/status` 能正确识别黑洞 IP 并过滤。

## 已知限制

- 只针对 `opencode.ai`，不做通用 IP 优选；
- 黑名单不持久化，每次 DSH 启动重新探测；
- 运行中修改代理配置需要重启 DSH 才能被插件感知；
- 企业网络做 TLS 中间人时探测会全部失败，插件会自动降级为不过滤。

## 许可证

Apache-2.0