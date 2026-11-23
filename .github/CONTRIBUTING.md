# 贡献指南

感谢参与 QQ 农场机器人（单机版）的改进！

本项目基于 [Asunxu/qq-farm-bot](https://github.com/Asunxu/qq-farm-bot)，所有改动都会经过维护者审核后合入 `main`。

---

## 提 PR 的流程

1. **Fork** 本仓库到你自己的账号
2. 从 `main` 切一个特性分支：`git checkout -b feature/xxx`
3. 在你的分支上改代码、提交
4. 推上去：`git push origin feature/xxx`
5. 在 GitHub 上点 **Compare & pull request**，按模板填好说明
6. 等待维护者审核 —— **main 分支受保护，只能通过 PR 合入**

分支命名建议：

| 前缀 | 用途 |
| --- | --- |
| `feature/` | 新功能 |
| `fix/` | 修 bug |
| `docs/` | 只改文档 |
| `refactor/` | 重构，不改行为 |

提交信息用中文或英文都可以，尽量一句话说明「改了什么」，例如：

```
fix: 修复 place 被动作去重挡住导致栏位填不满
feat: 新增「最贵作物」选种策略
```

---

## 本地开发

需要 Node.js 20+ 和 pnpm 10+。

```bash
corepack enable
pnpm install          # 安装依赖
pnpm build:web        # 构建前端
pnpm dev:core         # 启动后端（面板在 http://localhost:3007）
pnpm dev:web          # 需要前端热更新时另开一个终端
```

常用命令：

```bash
pnpm lint             # 代码检查（前后端）
pnpm -C core test     # 后端测试（node:test）
pnpm build:web        # 生产构建
pnpm -C core build:win  # 打 Windows 单机 exe
```

---

## 改代码前请先看

| 文件 | 作用 |
| --- | --- |
| `core/src/runtime/` | 后端运行时：worker 管理、账号恢复、调度 |
| `core/src/services/ranch-automation.js` | 牧场自动化（入栏、偷取、帮助） |
| `core/src/services/planting-service.js` | 农场种植与选种策略 |
| `core/src/plugins/host.js` | 活动插件宿主 |
| `web/src/composables/settings/` | 面板的自动化开关与策略设置 |

### 约定

- **不要提交运行时数据**：`core/data/`（账号凭据、日志）、`core/dist/`、`web/dist/`、`.env` 已在 `.gitignore` 里
- **不要在代码里硬编码账号、密码、token**（包括写死的测试凭据）
- **协议相关改动**要注明抓包/日志依据，不要凭猜测改字段号
- **新增自动化开关**必须同时改：`core/src/models/store.js` 的白名单 + 前端选项 + `core/src/models/user-store.js` 的默认值
- **活动相关改动**遵循 `core/docs/activity-update-runbook.md`

---

## 提交前请确认

- [ ] `pnpm lint` 无报错
- [ ] `pnpm -C core test` 全部通过
- [ ] `pnpm build:web` 构建成功
- [ ] 改动如果涉及自动化行为，**补了对应的测试**（`core/test/`）
- [ ] 没有把本地数据、依赖、构建产物带进提交

---

## 需要注意的行为约定

这几个是踩过坑之后定下来的，改动时别退回去：

| 约定 | 原因 |
| --- | --- |
| 账号掉线后恢复要**一直能恢复** | 曾经的「熔断」是永久放弃，账号会一直离线到进程重启。现在改成降级重试 |
| 换 Code 的网络请求必须有**超时** | 否则请求卡死会让账号永远离线 |
| 恢复日志要**如实反映结果** | 之前巡检无条件打「已安排恢复」，把真实原因藏起来了 |
| 动作去重身份要带上**状态变量** | `place` 早期只用动作身份去重，导致同一栏位同一品种只放一次 |
| 选种/入栏要按**等级或品质**排序 | 固定取列表第一项会永远塞最低级的品种 |

---

## 讨论

有想法先开 Issue 讨论，别直接开大 PR。
