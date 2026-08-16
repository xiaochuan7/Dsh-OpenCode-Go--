# OpenCode Go 额度显示（DeepSeek Harness）

> 面向 DeepSeek Harness 的社区插件，按官方 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题收录，可配合任何编码 Agent 自动安装适配。

在 DeepSeek Harness 聊天界面中，为内置的「上下文占比」圆环面板（ContextMeter）添加 **OpenCode Go 套餐额度** 显示：

- 面板顶部显示 **月限额 / 周限额 / 五小时**（滚动窗口）三项
- 每项显示：名称、使用进度条、剩余百分比（`剩 X%`）、重置时间
- 进度条颜色按剩余量分级：**≥50% 绿 / ≥20% 橙 / <20% 红**
- 只在当前 LLM 网关是 OpenCode Go 时显示；切到 DeepSeek 官网等其他网关时自动隐藏，保持官方原样
- 前端与后端解耦：路由缺失或不可用时不影响原有上下文占比功能

## 效果展示

点输入框上方的上下文占比圆环，面板顶部即显示额度：

<img width="1323" height="617" alt="image" src="https://github.com/user-attachments/assets/1af5b04a-85ae-4ec4-83a1-b0cc6dab0fb3" />

面板细节：

<img width="488" height="476" alt="image" src="https://github.com/user-attachments/assets/e38b641a-cc70-4036-b1c3-31fd35e7f92b" />

> 以上为真实截图，数值来自当前 OpenCode Go 账户的真实配额。

## 方式一：让 AI Agent 自动适配（推荐）

把下面这段提示词发给你的编码 Agent（DSH、Claude Code、Cursor、Gemini CLI 等），它会根据你本地的实际版本自动完成改动，**不需要手动替换文件**：

---

> 为 DeepSeek Harness 项目添加「OpenCode Go 套餐额度」显示：在聊天输入框的上下文占比圆环（ContextMeter 面板）顶部显示额度区块。
>
> 参考实现见仓库 Dsh-OpenCode-Go-（如可用）：
> - `packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx` — 前端组件改动
> - `packages/client/ui-conversation/src/client/skeleton/ContextMeter.module.css` — 样式
> - `server/opencode-quota-route.mjs` — 服务端路由 `GET /api/opencode-quota` 参考实现
> - `server/cordis.patch.yml` — 挂载配置示例
>
> 要求（参考实现已覆盖，请按你的实际版本适配）：
>
> 1. **前端**：ContextMeter 面板顶部渲染「OpenCode Go 额度」区块，共三项：月限额、周限额、五小时。每项显示：名称、使用进度条、剩余百分比（`剩 X%`）、重置时间。进度条颜色按剩余量分级：≥50% 用绿色、≥20% 用橙色、<20% 用红色。
> 2. **数据源**：组件挂载后请求 `/api/opencode-quota`，之后每 60 秒刷新一次。响应格式：`{ ok: true, usage: { rolling: { percent, status, resetsAt }, weekly: {...}, monthly: {...} } }`，其中 `percent` 是**已用百分比**（剩余 = 100 − percent）。请求失败或 `ok` 不为 `true` 时隐藏额度区块，面板保持官方原样。
> 3. **服务端路由**：提供 `GET /api/opencode-quota`：
>    - 从部署配置读取 LLM 网关 `baseURL`（settings 的 `llm-deepseek.baseURL`，未设置时回退 `web-search-deepseek.baseURL` / 默认值）与 API key（`apiKeyEnv` 环境变量，按需回退 `OPENCODE_GO_API_KEY` → `DEEPSEEK_API_KEY`）
>    - 仅当 `baseURL` 匹配 `opencode.ai` 时返回额度；否则返回 `{ ok: false, notApplicable: true }`（面板自动隐藏）
>    - 请求 `{baseURL}/usage`（`Authorization: Bearer <key>`）获取 `usage.rolling / weekly / monthly`
>    - 成功结果缓存约 60 秒；失败不缓存（配置切换立即生效）
>    - 通过部署的 cordis 用户 patch（如 `~/.dsh/profiles/web/cordis.patch.yml`）挂载该插件，用 `webServer.register` 注册路由
> 4. **解耦**：路由缺失、不可用或网关不是 OpenCode Go 时，前端自动隐藏额度区块，不影响原有上下文占比功能。
>
> **完成标准**：构建后打开 GUI 的上下文占比圆环，面板顶部可见额度区块且三项数据正确（数值来自当前账户的真实配额）；把网关切到非 OpenCode Go 后额度区块消失、面板恢复官方原样。

---

## 方式二：手动安装（版本差异大，不推荐）

1. 把两个前端文件按原路径覆盖到你的 deepseek-harness 源码：
   `packages/client/ui-conversation/src/client/skeleton/`
2. 重新构建前端产物（`pnpm build` 或项目对应的打包命令）
3. 把 `server/opencode-quota-route.mjs` 放到你的用户 patch 目录（默认 `~/.dsh/profiles/web/`），并参照 `server/cordis.patch.yml` 在 `cordis.patch.yml` 里挂载
4. 确认 `settings.yaml` 中 LLM 网关 `baseURL` 指向 OpenCode Go（如 `https://opencode.ai/zen/go/v1`），并配置 API key 环境变量（`OPENCODE_GO_API_KEY` 或 `DEEPSEEK_API_KEY`）

## 目录结构

| 文件 | 说明 |
|---|---|
| `packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx` | 前端组件改动（额度区块渲染 + 轮询） |
| `packages/client/ui-conversation/src/client/skeleton/ContextMeter.module.css` | 额度区块样式 |
| `server/opencode-quota-route.mjs` | 服务端路由参考实现（`GET /api/opencode-quota`） |
| `server/cordis.patch.yml` | 路由插件的挂载配置示例 |

---

本插件为 DeepSeek Harness 社区插件，已按官方规范标记 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题（GitHub 仓库 Topics 中可查），并附官方 "powered by dsh" 徽章：

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
