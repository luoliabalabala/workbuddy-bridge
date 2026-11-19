# WorkBuddy Bridge 2.0

让 **Codex 与 ChatGPT Work 桌面端共用同一套 WorkBuddy 工具**。它控制本机 WorkBuddy 桌面应用；两种调用方使用相同 MCP 协议、参数验证和业务核心。无需构建、无需 npm 安装依赖、无需额外模型 API Key。

## 与原插件的区别

原 `dsh-workbuddy-bridge 1.0.2` 只能由 DSH 注册工具。本版增加标准 MCP stdio、通用插件清单、命令行入口和使用 skill，并保留 DSH 适配器。原始压缩包在相邻 original 目录中保留不改。

修复方向包括：默认不自动关闭应用、启动重试补齐 launch、配置失败停止发送、会话歧义拒绝、依据本轮转录核对结果、跨进程锁、文件复制防覆盖、完整打包数据库辅助脚本。具体证据和验收范围见 [审查与验证](docs/review.md)。

## 适用环境

- Windows，Node **22.13+**（本机检查为 Node 24.18.0）。
- 已安装并登录 WorkBuddy；默认读取 `%USERPROFILE%\.workbuddy\workbuddy.db`。
- Codex 或 ChatGPT Work **桌面本地运行环境**。本机应用控制不是云端服务。
- 通过 WorkBuddy 自己的 Chromium CDP 端口操作 UI，通过只读 SQLite / JSONL 回收结果。当前 DOM 选择器继承原插件，WorkBuddy 更新后可能需要适配。

OpenAI 官方支持插件中的本地 stdio MCP 与 `${PLUGIN_ROOT}` 路径替换；这种包属于 desktop-only。详见 [本地 MCP 插件](https://developers.openai.com/plugins/deploy/desktop-only)、[插件打包](https://developers.openai.com/plugins/build/plugins)。这里交付的是本地开发包，不代表已上传、审核、安装到账号或完成双端端到端验收。

## 安装和调用

发行 ZIP 自带一个本地市场根目录：`.agents/plugins/marketplace.json` 和 `plugins/workbuddy-bridge/`。将整个发行目录解压到固定位置，再执行：

```powershell
codex plugin marketplace add '你的解压目录\workbuddy-bridge-2.0.0-codex-work'
```

这一步会登记本地市场，仍需在 ChatGPT 桌面客户端插件目录选择 **WorkBuddy 本地工具** 并安装 **WorkBuddy 桥**；按客户端要求重启后，在本地运行的新聊天检查 `workbuddy_*` 工具。本次没有替你登记市场、安装或重启客户端。不同产品版本的市场可见性可能不同，实际安装需在目标版本验收。[官方本地市场说明](https://developers.openai.com/plugins/build/plugins#build-your-own-curated-plugin-list)

插件同时包含 portable `plugin.json` + `mcp.json`，以及 `.codex-plugin/plugin.json` + `.mcp.json` 兼容清单。两者描述同一个服务器，不要手工注册两遍。

如果只是先在 Codex CLI 接入 MCP，也可以用绝对路径运行：

```powershell
codex mcp add workbuddy_bridge -- node '你的解压目录\workbuddy-bridge\bin\mcp.mjs'
```

这条命令会修改 Codex 的 MCP 配置；本次交付没有替你执行。它只配置 Codex，不会自动给 ChatGPT Work 安装插件。

独立检查不需要安装插件：

```powershell
node .\bin\cli.mjs doctor
node .\bin\cli.mjs tools
node .\bin\cli.mjs call workbuddy_run '{"task":"一句话说明这个目录下有哪些文件；不要修改文件。","session":"new"}'
```

最后一条会实际启动/使用 WorkBuddy 并提交任务；前两条只做环境和工具定义检查。相对脚本路径基于本插件根目录。旧 Windows PowerShell 对本机程序的 JSON 引号处理有差异，优先使用 PowerShell 7，或通过 MCP 传结构化参数。

安装后可对 Codex 或 ChatGPT Work 说：

> 用 WorkBuddy 桥新建任务，先查看可选模型，选择我指定的模型执行任务，完成后给我答案、会话 ID 和文件的原始路径。

## 工具

| 工具 | 用途 |
| --- | --- |
| workbuddy_status | 观察应用；默认 launch=false |
| workbuddy_sessions | 只读会话列表 |
| workbuddy_models / workbuddy_experts | 从当前界面读取选项 |
| workbuddy_open | 打开明确会话或 new |
| workbuddy_configure | 打开明确目标并配置 |
| workbuddy_send | 打开明确目标并发送，返回会话及回合 evidence |
| workbuddy_wait | 等待明确会话；evidence 可限定本次回合 |
| workbuddy_collect | 回收答案、候选文件路径，可选摘要和复制 |
| workbuddy_run | 在一个跨进程锁内完成整个流程，推荐 |

分步调用中 configure 和 send 必须传 `session`，避免继承其他宿主切换后的窗口。需要“配置 + 发送”连续性时使用 run。等待超时**不会取消**已提交任务，不要直接重发。

## 配置

默认端口 `9222`，默认不自动重启正在运行的应用。应用没有开启端口时可在明确授权后由工具 `restart:true` 重启；正在忙碌或无法确认状态时拒绝关闭应用。

设置环境变量 `WORKBUDDY_BRIDGE_CONFIG` 为一个 JSON 配置文件的绝对路径：

```json
{
  "port": 9222,
  "autoRestart": false,
  "waitTimeoutSec": 900,
  "appPath": "C:\\实际安装位置\\WorkBuddy.exe"
}
```

可用变量：`WORKBUDDY_CDP_PORT`、`WORKBUDDY_EXE`、`WORKBUDDY_DB`、`WORKBUDDY_HOME`、`WORKBUDDY_BRIDGE_LOCK`。不配置就使用当前用户的默认目录；不要在两个宿主中设置不同的锁路径，否则无法互斥。

锁放在 `%USERPROFILE%\.workbuddy\bridge-locks\cdp-9222.lock`（设置 HOME 时随之改变）。跨进程同时调用返回 `BRIDGE_BUSY`，不按超时强抢锁。异常退出留下锁时，先核对记录中的 PID 已退出并确认无调用，再删除该**具体锁文件**。

WorkBuddy 使用自身权限执行任务，不会自动继承 Codex 的沙箱。按实际需要明确授权任务目录与外部动作。这里不会创建公网端口、部署隧道、读取密钥或复制账号数据。

## 开发与旧 DSH

```powershell
node --test tests/*.test.mjs
```

DSH 可使用 `dsh-adapter.js` 的 `apply` / `inject` 导出注册同一套工具，需按 DSH 的宿主包配置设置入口。未直接把该通用包声明为原 DSH 安装包，避免使用错误的宿主主入口。
