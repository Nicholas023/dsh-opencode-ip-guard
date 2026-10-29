# 发布记录：npm 0.1.0

> 时间：2026-10-29 ｜ 状态：**已发布成功**

## 包信息

| 项 | 值 |
|---|---|
| 包名 | `dsh-opencode-ip-guard` |
| 版本 | `0.1.0`（首发） |
| registry | https://registry.npmjs.org/dsh-opencode-ip-guard |
| 页面 | https://www.npmjs.com/package/dsh-opencode-ip-guard |
| 维护者 | nicholas023 |
| shasum | `359f5f9a32ba857a05243b28cb6a5b341b6687c7`（与本地 tgz 一致） |
| 内容 | 13 个文件，54.0 kB 打包 / 152 kB 解包 |

## 发布过程中遇到的两个坑（记下来避免下次踩）

1. **npm 强制 2FA**：未启用 2FA 的账号发布直接 403（`E403 Two-factor authentication ... required`）。
2. **staged publishing 暂存审核**：用 bypass-2FA 的 granular token 发布新包时，npm 会先创建
   `0.0.0-stage` 占位版本，真实版本进入暂存区，**需要维护者在网页上用 2FA 显式批准**才会上线。
   批准入口：https://www.npmjs.com/settings/nicholas023/packages 的 Staged Packages 标签页。
3. **本地缓存会骗人**：批准后立即 `npm install` 可能仍装到 `0.0.0-stage`（缓存了占位包）。
   验证时先 `npm cache clean --force`，或显式指定版本 `npm install dsh-opencode-ip-guard@0.1.0`。

## 验证结果

- `dist-tags.latest` = `0.1.0` ✅
- 显式安装 0.1.0：13 个文件齐全，undici 依赖正常安装 ✅
- 不带版本号安装（latest 解析）：正确装到 0.1.0 ✅

## 安全待办

- [ ] **撤销对话中暴露的 granular token**：https://www.npmjs.com/settings/nicholas023/tokens
      （该 token 曾出现在对话记录里；用户表示不担心，但按最佳实践仍建议轮换）

## 已知遗留

- registry 上仍保留 `0.0.0-stage` 占位版本（npm 暂存机制的产物），不影响安装，无需处理。