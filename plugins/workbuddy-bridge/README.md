# WorkBuddy Bridge 2.1.0

Codex 与 ChatGPT Work 桌面本地聊天共用的 WorkBuddy MCP 工具。Windows、Node22.13+，零 npm 依赖；无需额外 API Key。控制的是 WorkBuddy，自身执行权限不继承 Codex 沙箱。

## 启动规则

**按用户2026-11-17的要求：需要启动/连接应用且发现已运行但没有调试端口时，默认强制重启以开启端口，不因忙碌记录暂停。可能中断应用内正在执行的任务。** 端口已可用则直接复用。`workbuddy_status({launch:false})` 保持只读，不启动或重启。可显式配置 `autoRestart:false` 禁用默认重启；`restart:true` 是明确重启请求。重启返回 restartAudit，列明原因和观测到的活跃会话数量；读库失败也不阻止已授权的重启。

## 任务、恢复与重试

1. 完整委派使用 `workbuddy_run`，提供 task、session和可选实时模型配置。建议始终给稳定的 `requestId`；同一键与相同任务只恢复，不再发送，换任务使用新键。
2. 发送前保存 dispatch 票据；返回 `dispatchId`、可能已识别的 `sessionId` 和 evidence。`pending-observation` 表示暂未观察到归属，不等于未发送。sendState为`send-outcome-unknown`时，submitted是null；不要盲目重发。
3. 用 `workbuddy_recover({dispatchId})` 继续识别。已从sessions恢复ID时可同时传sessionId，由桥核对原消息指纹和时间再绑定。2.0失败返回的原evidence可通过recover显式导入；不要自行修改opaque evidence。
4. 用 `workbuddy_wait({dispatchId,timeoutSec:30})` 等待；等待预算结束返回`waiting`，不是执行失败，也不会取消。默认wait/run等待30秒，长任务用同一票据续等。原sessionId/evidence接口仍保留。
5. 纠错使用同一明确sessionId和新的requestId发送，得到新回合票据。运行中的会话先取消并确认非忙，再发送新回合；不把追加指令混成原回合。
6. 用 `workbuddy_cancel({dispatchId})` 中断；仅操作该会话的可见停止按钮，不以重启代替取消。requested与confirmed分开：confirmed只表示随后观测到非忙，不能推定后端取消原因。已有新用户回合时，旧票据不能取消它。

票据默认存 `%USERPROFILE%/.workbuddy/bridge-dispatches/`，可配置dispatchDir。保存任务SHA256、字节基线、消息ID、模型选择与元数据观测，不保存完整任务正文。基于文件互斥串行化UI流程；只读等待/恢复与单独校验的取消不被长run阻塞。异常退出的旧锁不按时长强抢，需确认原进程退出后清理。

## 身份与模型

历史导航以侧栏data-conversation-id定位；以可见composer的data-conversation-input-id验证。标题可以变化或重复，不能代替ID。找不到稳定标识时返回期望/实测信息并拒绝输入。

模型分别记录提交时页面选择、后续session/global元数据与后端独立证据。用户已说明：其他任务切换全局模型会影响显示，但不会改变已运行任务的模型。因此**不以会话模型元数据变化认定任务换模，也不因此中断**。本工具没有逐回合后端证明；该字段保持NOT_INDEPENDENTLY_OBSERVED。used/size不作为计费Token。

## 文件与耗时

collect区分修改候选、引用候选，不能凭路径或mtime宣称本轮真实产出。未有独立写入归因时independentlyAttributedOutputs为空。`mode:copy`必须同时提供目标outputDir和源目录白名单allowedOutputDirs，只复制白名单内的工作区文件，保留相对目录且不覆盖已有不同内容。

票据可返回发送以来墙钟时间、宿主实际等待采样耗时与最近转录变化观测时间；这些不是模型纯执行耗时、节省比例或计费数据。未取得的usage/cost保持未测量。

## 安装与验证

发行ZIP包含 `.agents/plugins/marketplace.json` 与 `plugins/workbuddy-bridge/`。将发行目录放在固定位置，使用 `codex plugin marketplace add <发行根目录>` 登记，再 `codex plugin add workbuddy-bridge@workbuddy-local` 安装；新本地聊天加载更新后的工具。更新同名市场时先按CLI更新其来源，不重复注册MCP。Codex与ChatGPT Work的本地市场可见性以目标桌面版本为准。

仅配置Codex MCP可使用 `codex mcp add workbuddy_bridge -- node <插件绝对路径>/bin/mcp.mjs`，这不等于替Work安装插件。portable与兼容清单描述同一服务，不要注册两遍。

插件根目录中运行：

```powershell
node bin/cli.mjs doctor
node bin/cli.mjs tools
node --test tests/*.test.mjs
```

配置文件由WORKBUDDY_BRIDGE_CONFIG指定，支持port、appPath、dbPath、dispatchDir、waitTimeoutSec、autoRestart等。环境变量另支持WORKBUDDY_CDP_PORT、WORKBUDDY_EXE、WORKBUDDY_DB、WORKBUDDY_HOME、WORKBUDDY_BRIDGE_LOCK；两端必须共用锁和票据目录。doctor仅观察，不启动。

当前12项工具：status、sessions、models、experts、open、configure、send、wait、recover、cancel、collect、run，均带workbuddy_前缀。DSH适配器继续调用相同核心。

详细修复依据、28项离线测试和真机回归见 [2.1修复记录](docs/2.1-fixes.md)。2.0的历史审查保留在docs/review.md，其旧启动规则已被本版用户要求取代。

[官方本地MCP规范](https://developers.openai.com/plugins/deploy/desktop-only) · [插件与本地市场](https://developers.openai.com/plugins/build/plugins)。本包仅桌面本地执行，不部署公网入口。
