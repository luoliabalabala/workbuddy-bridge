# 架构说明

## 分层

```
DSH 智能体
  └─ workbuddy_* 工具（src/index.js：注册 10 个 ToolDefinition）
       └─ src/lib/flow.js   业务流水线（status/open/configure/send/wait/collect/run）
            ├─ src/lib/dom.js     页面侧操作（读界面状态、选模型、设强度/上下文、召唤专家、输入、发送）
            ├─ src/lib/cdp.js     CDP 客户端（HTTP /json/list + WebSocket 命令、鼠标事件、截图）
            ├─ src/lib/app.js     进程探测与带调试端口启动（computer-use 的 launch_app 优先）
            ├─ src/lib/store.js   SQLite 只读查询 + 会话 JSONL 轨迹解析
            └─ src/lib/paths.js   路径推导（数据目录、转录目录、可执行文件候选）
```

插件是纯 Host 插件：`inject = ['tools']`，在 `apply(ctx, config)` 里用 `ctx.effect(() => ctx.tools.register(tool))` 注册工具，随插件卸载自动回收。

## 为什么走 CDP 而不是 UIA

WorkBuddy 是 Electron 应用。UIA 树对 Chromium 内容只暴露有限的命名节点，而且工具侧会截断长树；CDP 能直接读 DOM、按选择器定位、派发真实鼠标事件（`Input.dispatchMouseEvent`），并且能读页面里的真实文案（模型名、专家名、上下文档位），因此操作可验证、错误可解释。

启动要求：`WorkBuddy.exe --remote-debugging-port=9222`。插件通过 CDP 的 `/json/list` 拿目标列表，用页面内探针区分主窗口与设置窗口（设置窗口是独立 BrowserWindow，同样是 CDP 目标）：

```js
!!document.querySelector('.settings-modal') ? 'settings' : 'main'
```

## 界面状态机

`readState()` 先把当前界面判成四类，供后续操作选择路径：

| 视图 | 判据 |
| --- | --- |
| `settings` | 存在 `.settings-modal` |
| `conversation` | 存在 `.cr-message-list__content`（同时有 `.conversation-input__box`、`.cr-context-usage`） |
| `home` | 无消息列表，且 `button.quick-actions__item` 数量 > 0 |
| `other` | 其余情况（弹窗、加载中等） |

关键点：首页和会话页都含 `._editable_1cxd2_1` 和 `.cr-input-box`，所以不能靠"输入框存在"判断视图——早期按这个等首页会瞬间通过，导致 `open new` 静默无效。

## 模型 / 思考强度 / 上下文

三者都在模型选择器的二级面板里，菜单是 hover 驱动的，必须用真实鼠标事件：

1. 点 `.cr-model-selector__trigger` 打开菜单，等 `.cr-model-selector__item` 出现（有进入动画，行初始 `opacity≈0`，要先等可见）。
2. 悬停目标行（先 `scrollIntoView({block:'center'})` 再取中心点，行在折叠区外时原始 rect 是错位的），约 900ms 后出现 `.cr-model-selector__sub-menu`。
3. 二级动作行 `.cr-model-selector__sub-menu-action--clickable` 上的文字形如 `思考强度高`、`上下文窗口300K`，点击后弹出 `.cr-model-selector__sub-panel`。
4. 面板内容：
   - 思考强度 → `.cr-model-selector__sub-panel-item`（`--active` 表示当前档），档位 `低/中/高/超高`。
   - 上下文窗口 → 同样结构的 `300K/600K/960K`，但档位随模型不同（`DeepSeek-V4-Pro` 是 `300K/600K/1M`）。按数值匹配而不是按字面标签，超出最大档时取最大档。
   - 思考模式开关 → `.cr-model-selector__sub-panel-toggle` 里的 `input[role="switch"]`；开关关闭时面板**只剩开关、没有档位**，所以选强度前若发现 `items.length === 0 && toggleOn === false`，要先点 input 本身（点容器中心会被 label 吞掉）。

模型不支持某档位、或面板列出空选项时，`openModelSubPanel` 会抛出带原因的错误（`model "X" exposes no 思考强度 control` / `listed no choices`），流水线把它写进 trace，不会假装成功。

## 专家

专家市场页（侧栏 `专家·技能·连接器`）每张卡片 `article` 带一个召唤按钮，`aria-label` 为 `召唤<专家名>`。这些按钮默认 `display:none`，悬停卡片才出现，坐标点击不可靠，因此用页面内 `scrollIntoView` + `target.click()`。召唤成功后回到首页输入框，工具栏出现专家 chip，**同时输入框会被预填一段示例任务**——所以发送前必须先清空编辑器，否则任务文本会和预填内容粘在一起。

## 发送与结果

- 输入：聚焦 contenteditable，用 `Input.insertText` 写入；`insertText` 是**追加**语义，清空要单独做（全选 + 删除）。
- 发送：点 `.cr-send-button`，随后在数据库中按时间找新出现的会话行拿到 session id。
- 完成判定：以 `workbuddy.db` 的 `sessions.status` 为准（`completed` / `error`），每隔 4 轮才做一次界面探针作为兜底；这样渲染进程卡顿不会把等待拖死。
- 答复文本：读会话 JSONL（`%USERPROFILE%\.workbuddy\projects\<slug>\<sessionId>.jsonl`）里最后一条 assistant `output_text`；文件清单来自 `file-history-snapshot` 事件的 `trackedFileBackups`，并过滤成真实存在的文件。

## 产物策略

- WorkBuddy 自己写的文件一律保留原位，工具只回报**绝对路径**（新任务的工作目录是 `%USERPROFILE%\WorkBuddy\<yyyy-MM-dd-HH-mm-ss>\`，会话 `cwd` 字段为准）。
- `outputDir` 只承载摘要 `workbuddy-result-<sessionId>.md`。
- `mode: "copy"` 才复制副本，且先比对大小与 sha256，已存在同内容文件则跳过——避免重复存储。

## 配置项

`cordis.patch.yml` 里的默认配置：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `9222` | CDP 端口 |
| `launchTimeoutMs` | `30000` | 启动并等到端口就绪的上限 |
| `waitTimeoutSec` | `900` | 单个任务等待完成的上限 |

`WB_DEBUG=1` 环境变量会让 `run` 往 stderr 打每一步 trace，便于定位卡在哪一步。

## 会话识别兜底

新建任务发送后，插件先用 sessions.created_at >= sendAt-3s 精确认领会话；若数据库辅助进程这次没答上来，则退回「读最近 5 条、按 created_at 取最新且不早于发送前 60 秒」的那条，并把读库失败原因写进 trace，避免任务跑完却因一次读库抖动报 unknown。

## 产物去重

collect 默认只回报 WorkBuddy 自己写出的绝对路径；mode:"copy" 才会复制到 outputDir，复制前用大小 + sha256 比对，一致即标记 `skipped: identical copy already present`。
## 调试端口的自动接管

WorkBuddy 是单实例 Electron 应用：先启动的进程占住实例，之后再带 `--remote-debugging-port` 启动会被静默忽略。因此插件把"让端口可用"变成`ensureRunning` 的内部决策，而不是调用者的负担：

| 现场 | 处理 |
| --- | --- |
| 端口已应答 | 直接用 |
| 没开应用 | 以 `--remote-debugging-port=<port>` 启动（优先 computer use 的 `launch_app`，失败退回 spawn） |
| 开着但没端口 | 关窗口（`close_window` → `taskkill`）后带参重启；首次没起来再干净重启一次 |
| 数据库显示有 `active` 会话且刚活跃 | **拒绝**重启并说明是哪个会话在忙，避免把正在跑的回合杀掉 |
| `autoRestart: false` | 只报 `NEEDS_RESTART`，不自动动手 |

启动后 `waitForWindows` 会等渲染进程出现页面目标（`/json/version` 比 React 挂载更早），`status` 在刚拉起时还会再等 1.5s 让界面稳定，避免把首页误报成 `view: other`。