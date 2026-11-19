# WorkBuddy Bridge

在 Windows 桌面上，从 Codex 或 ChatGPT Work 调用本机 WorkBuddy。桥接插件负责提交任务、跟踪具体回合并取回答复与候选文件路径。当前推荐版本为 **2.3.0**。

- 在 WorkBuddy 中选择模型、思考强度、上下文和专家。
- 将调用会话或项目映射到 WorkBuddy 原生项目，按需要续聊或开新任务。
- 用持久化票据恢复、等待和取消，结合重试键防止重复发送。
- 后台监控可在提交后接手等待。监控写入结果后退出，CLI 也可按次启动。

## 快速开始

需要本机 Windows、可交互的 WorkBuddy 桌面端，以及 Node.js 22.13 或更新版本。MCP 在桌面本地执行环境运行。WorkBuddy 按它自己的权限执行任务。

从 [版本包目录](releases/) 选择 2.3.0 ZIP，解压到固定目录。也可以克隆本仓库，直接使用仓库根目录作为市场目录。

```powershell
# 在解压后的版本目录或仓库根目录运行
codex plugin marketplace add .
codex plugin add workbuddy-bridge@workbuddy-local
node .\plugins\workbuddy-bridge\bin\cli.mjs doctor
```

新建本地聊天，启用「WorkBuddy 桥」。第一次可以先让它检查本机状态，或用 CLI 执行只读的 `doctor`。ChatGPT Work 需要允许本地执行，具体可见性取决于桌面版本与工作区设置。纯云端执行环境无法直接访问本机 WorkBuddy。

2.1.0 起，需要连接 WorkBuddy 时，如果桌面应用已运行但调试端口不可用，桥默认重启应用，可能中断进行中的任务。想禁用自动重启，可在 `WORKBUDDY_BRIDGE_CONFIG` 指向的 JSON 配置中设置 `"autoRestart": false`。状态检查请明确使用 `launch: false`。

## 任务如何执行

用 `workbuddy_run` 提交并短时等待。长任务用 `workbuddy_send` 获取 `dispatchId`，再用 `workbuddy_watch` 的 `start` 开始后台监控，之后以同一票据调用 `status` 或 `result`。提交结果未知时先 `recover`，重试继续用原 `requestId`。

2.3.0 默认在 MCP 调用结束后退出执行子进程，宿主保留 MCP 通信入口。频繁使用时可设置 `WORKBUDDY_BRIDGE_WARM_SECONDS=60`。单次 CLI 完成即退出。监控在任务达到终态并保存结果、超时或失败后退出。

详细参数和使用限制见 [插件文档](plugins/workbuddy-bridge/README.md)、[调用说明](plugins/workbuddy-bridge/skills/workbuddy-bridge/SKILL.md)和[版本记录](CHANGELOG.md)。

## 实现与验证

`MCP / CLI → 桥接执行器 → WorkBuddy 本地调试界面`。会话状态与回复通过本机 SQLite 和转录读取。文件路径仅是输出候选，模型显示和会话元数据也无法独立证明后端模型身份。

```powershell
Set-Location .\plugins\workbuddy-bridge
node --test tests/*.test.mjs
```

2.3.0 的 43 项自动化测试覆盖协议、会话与票据、项目隔离、预填文本与监控接力。此前在 Windows 上验证过 WorkBuddy 5.11.3 的项目分组、续聊和专家流程。ChatGPT Work 的独立端到端实测未记录。

历史 DSH 包请在 DSH 内从本地安装其 `src/` 目录。原始包的使用说明与代码随 [v1.0.2 快照](releases/) 保存。

本项目为独立集成。原始 DSH 包未附开放源代码许可证，版本材料按私有归档管理。[来源与许可证说明](NOTICE.md)

