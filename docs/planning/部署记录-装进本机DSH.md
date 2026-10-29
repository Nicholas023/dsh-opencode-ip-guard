# 部署记录：装进本机 DSH

> 时间：2026-10-29 ｜ 目标：把 dsh-opencode-ip-guard 以 `link:` 方式装进本机 DSH profile，验证实际效果。

## 一、前置：npm CLI

本机的 node 是 DSH 自带的独立 `node.exe`（Node 24.21.0），**没有随包分发的 npm**。已单独安装：

| 项 | 值 |
|---|---|
| 安装位置 | `C:\Users\Nicholas023\.dsh-tools\npm` |
| 版本 | npm 12.2.1 / npx 12.2.1 |
| 启动方式 | `npm.cmd` 包装了 DSH 自带 node.exe + `bin/npm-cli.js` |
| PATH | 已加入**用户级** PATH（新开的终端生效） |

npm 账号：**用户已于 2026-10-29 注册**；本机尚未 `npm login`（登录需交互式输入，未代做）。

## 二、插件安装

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "link:D:\DSH-Files-v2\02-DSH开发\dshapi长连接插件"
```

- 安装方式：`link:`（指向源码目录，改代码后重启即生效）
- 依赖变化：8 → 9，**只新增，无删除、无版本变更**（已与备份逐项对比）
- `bundles`：17 → 18，追加 `dsh-opencode-ip-guard`
- 其 `undici` 依赖解析到本地项目的 `node_modules/undici`

## 三、检查点与回滚

安装前的备份（同目录）：

- `package.json.bak-ipguard-20261029-163313`
- `pnpm-lock.yaml.bak-ipguard-20261029-163313`

**回滚步骤**（禁用插件）：

1. 把 profile 的 `package.json` 恢复为上述备份；
2. 或最小改动：从 `dsh.profile.bundles` 里删掉 `dsh-opencode-ip-guard` 这一项；
3. 重启 DSH。

## 四、生效条件

**必须完全退出 DSH 再启动**——host 插件在进程启动时加载，client 面板随 Web GUI 加载；热重载只对配置生效。

## 五、重启后的验证清单

1. **面板**：会话头部右上区域应出现小卡，显示「IP 防护：N 个黑洞」；
2. **状态接口**：

   ```powershell
   curl.exe http://127.0.0.1:<你的GUI端口>/opencode-ip-guard/status
   ```

   应返回 JSON，含 `state` / `entries` / `lastProbeAt`；
3. **黑洞识别**：`entries` 里应能看到 `172.65.90.20` 为 `black`；
4. **阴性对照（最强）**：配置 `forceIps: ['172.65.90.20','172.65.90.21']`，确认请求仍能走通（说明过滤生效），
   而只放 `['172.65.90.20']` 时会按契约回退原始列表（这是设计，不是 bug）。

## 六、待办

- [ ] 用户重启 DSH 并验证；
- [ ] `npm login` + `npm publish`（账号已注册）；
- [ ] 发布后把 npm 安装方式写进 README 的「方式一」。