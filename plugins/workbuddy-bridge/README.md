# WorkBuddy Bridge 2.3.0

Codex 与 ChatGPT Work 桌面本地聊天共用的 WorkBuddy MCP 工具。Windows、Node22.13+，零 npm 依赖；无需额外 API Key。控制的是 WorkBuddy，自身执行权限不继承 Codex 沙箱。

## 低内存后台模式

1. 用 `workbuddy_send`（省略 `waitSeconds`）得到 `dispatchId`，再用 `workbuddy_watch` 的 `start` 开始后台观察。相同票据复用监控。默认最多等 30 分钟，可用 `timeoutSec` 调整。
2. 每次 MCP 调用返回后释放桥接执行器。独立监控负责读取本机 SQLite 和转录，确认本回合完成后，将回复与文件候选保存到票据目录的 `watch-<dispatchId>.json`，然后退出。
3. 用 `action:status` 查询，用 `action:result` 取回结果。宿主的 MCP 通信进程一直监听调用。可用 `node bin/cli.mjs call` 按次启动并完整退出；频繁调用可设置 `WORKBUDDY_BRIDGE_WARM_SECONDS=60`，让 MCP 执行器热驻留 60 秒（默认 0，上限 300）。

WorkBuddy 桌面程序继续执行任务。监控只读应用数据，结果通过工具查询。超时或出错后可用同一票据继续观察；异常强杀留下监控锁时，确认记录的进程已退出再清理该锁。

## 2.2 默认项目、会话与执行配置

- 默认 **Hy4 / 思考强度高 / 300K**；代码相关任务默认召唤 **高级开发工程师（吴八哥）**。显式model、effort、contextK、expert优先，taskKind可明确code/general；未标注时仅用本地规则初判代码任务。
- 提供callerProjectKey时，一个调用方项目对应一个原生WorkBuddy分组/space；未提供项目标识时，一个callerConversationId对应一个分组。首次创建并命名，名称保留调用方可读名称和稳定短后缀；过长时保守缩短，完整名称保留在调用上下文。projectName可显式更新原生分组名。
- 同一个调用方会话再次run/send，**省略session或传auto**，优先复用该会话的上次WB任务。不同调用方会话共享项目时，各自保存上次任务，不串话。显式session:new始终新建，现有任务忙碌时不自动重复投递。
- 调用方Agent负责语义关系判断：relationship:related复用；unrelated在同项目另起任务；different-project配合topicKey建立新的主题项目分支；same-project返回基础项目。auto在缺少明确信号时偏向连续性，只用哈希关键词重合度粗筛极低关联任务，不能冒充语义理解。
- 专家无法在历史任务里直接更换；需要新专家而旧任务不匹配时另起任务。召唤专家后的示例输入会清空，最终完整任务文本验证一致才发送；发送后核对原生space_id，避免专家召唤把任务带离项目。

**调用方标识由调用Agent自动组织，不需要用户手工填写。** MCP可能跨聊天共享进程，因而不把服务启动时的CODEX_THREAD_ID当作每次调用身份：MCP调用须在参数或本插件支持的逐请求_meta中携带callerConversationId。CLI可以使用当前任务环境的CODEX_THREAD_ID/CODEX_SESSION_ID；项目身份只接受明确的callerProjectKey/CODEX_PROJECT_ID，不能拿插件安装目录猜项目。确实无法取得可靠身份时返回CALLER_CONTEXT_REQUIRED，不创建公共映射。使用方法见skills/workbuddy-bridge/SKILL.md。

```json
{
  "callerConversationId": "当前调用会话的稳定ID",
  "callerProjectKey": "当前项目稳定ID或规范化绝对目录",
  "callerProjectName": "Example Project",
  "taskKind": "code",
  "relationship": "related",
  "requestId": "本轮唯一且重试保持不变的键",
  "task": "本轮任务"
}
```

新增workbuddy_project可get/ensure/rename/attach（修复已发送任务的分组归属）。映射保存在`.workbuddy/bridge-routing/`，可配置routingDir；任务仅保存哈希关键词，不存完整提示词。重试键按调用会话和有效项目分区。2.1原有非映射调用可显式routing:manual；旧dispatchId仍可recover。

详情及42项测试、真机项目创建/改名/复用与专家预填验收见 [2.2记录](docs/2.2-routing.md)。

## 启动规则

**按用户2026-11-17的要求：需要启动/连接应用且发现已运行但没有调试端口时，默认强制重启以开启端口，不因忙碌记录暂停。可能中断应用内正在执行的任务。** 端口已可用则直接复用。`workbuddy_status({launch:false})` 保持只读，不启动或重启。可显式配置 `autoRestart:false` 禁用默认重启；`restart:true` 是明确重启请求。重启返回 restartAudit，列明原因和观测到的活跃会话数量；读库失败也不阻止已授权的重启。

## 任务、恢复与重试

1. 完整委派使用 `workbuddy_run`，提供 task、session和可选实时模型配置。建议始终给稳定的 `requestId`；同一键与相同任务只恢复，不再发送，换任务使用新键。
2. 发送前保存 dispatch 票据；返回 `dispatchId`、可能已识别的 `sessionId` 和 evidence。`pending-observation` 表示暂未观察到归属，不等于未发送。sendState为`send-outcome-unknown`时，submitted是null；不要盲目重发。
3. 用 `workbuddy_recover({dispatchId})` 继续识别。已从sessions恢复ID时可同时传sessionId，由桥核对原消息指纹和时间再绑定。2.0失败返回的原evidence可通过recover显式导入；不要自行修改opaque evidence。
4. 用 `workbuddy_wait({dispatchId,timeoutSec:30})` 等待；等待预算结束返回`waiting`，不是执行失败，也不会取消。默认wait/run等待30秒，长任务用同一票据续等。原sessionId/evidence接口仍保留。
5. 纠错默认省略session，按调用方映射复用前次会话；也可显式提供准确sessionId。使用新的requestId，得到新回合票据。运行中的会话先取消并确认非忙，再发送新回合；不把追加指令混成原回合。
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

当前14项工具：status、sessions、models、experts、open、project、configure、send、wait、watch、recover、cancel、collect、run，均带workbuddy_前缀。DSH适配器继续调用相同核心。

详细修复依据、28项离线测试和真机回归见 [2.1修复记录](docs/2.1-fixes.md)。2.0的历史审查保留在docs/review.md，其旧启动规则已被本版用户要求取代。

[官方本地MCP规范](https://developers.openai.com/plugins/deploy/desktop-only) · [插件与本地市场](https://developers.openai.com/plugins/build/plugins)。本包仅桌面本地执行，不部署公网入口。
