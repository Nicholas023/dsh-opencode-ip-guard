## 本版新增：会话头兜底注入（x-opencode-session）

opencode 的网关对缺少 `x-opencode-session` 的请求直接返回 **400 MissingSessionID**（本地已实测复现：带任意非空值 → 正常路由；不带 → 立即 400）。这个头同时是它把同一会话钉到同一上游后端的依据，钉稳了 prompt cache 才能整段对话保持温热。

DSH 自身的链路本来就会带这个头（agent-loop 塞 `sessionId` → 适配器透传 → pi-ai 加头），本版做的是**兜底**：万一某个版本或某条旁路请求漏了，插件在 HTTP 出口补上。

### 实现要点

- 监听 `llm/stream`，只对 `opencode` / `opencode-go` 路由的调用生效；
- 用 `AsyncLocalStorage` + **包装异步迭代器**，保证惰性流里真正发 HTTP 请求时仍读得到会话值（只 `als.run(next)` 是无效的，这是关键坑）；
- **请求已带该头 → 原样放行，绝不覆盖**（覆盖会破坏会话亲和）；
- 与黑洞 IP 过滤完全解耦：任一模块失败不影响另一个。

### 新配置段

```yaml
sessionHeader:
  enabled: true
  providers: [opencode, opencode-go]
  mode: session-id    # session-id | uuid
  debug: false
```

### 同期修正的文档问题

- 英文 README 的配置章节此前停留在 0.1.0 早期（缺 `connectTimeoutMs`、TTL、二次确认等键），已按代码补全；
- 中英文 README 均加入 `sessionHeader` 配置与安全边界说明。

### 测试

`node --test` → **109 项全部通过**（新增 16 项会话头单元测试，覆盖「不覆盖已有头 / 无 store 完全透传 / 惰性流 store 可见」等关键安全点）。

### 已知限制

- 只对配置里的 provider 路由生效，其它 provider 完全不受影响；
- 依赖 DSH 的 LLM 请求走 Node 全局 `fetch`（与参考实现一致的限制）。