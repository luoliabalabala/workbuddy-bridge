# 审查与验证

日期：2026-11-17。对象：用户提供的 dsh-workbuddy-bridge 1.0.2 ZIP；2.0.0 为本地改造版。

## 判断

值得改造。原包将 CDP、DOM、只读数据库与业务流程分开，核心不依赖 DSH 模型；DSH 绑定主要在工具注册和可选 computer-use 启动入口。通用 MCP 比分别为 Codex 与 ChatGPT Work 重写逻辑更合适。

## 原包发现与处理

| 原包事实 | 本版处理 |
| --- | --- |
| app.js 自动重启默认开启；只查最近5条、120秒内活跃记录；读库失败视为不忙 | 自动重启默认关闭；查所有 active/running/pending；读库失败拒绝关闭 |
| app.js 的重试先关闭应用但未再次启动 | 重试补上 launch；只有明确 restart 或 opt-in 自动重启才允许重试关闭 |
| flow.js 按最近记录、发送前60秒兜底认领新会话 | 仅匹配发送后创建、含本任务用户文本的唯一会话；失败不猜 |
| flow.js 续聊等待直接接受已有 completed；DOM兜底无会话归属 | 转录字节基线 + 本轮用户/助手事件 + 新状态证据；取消无归属 DOM 完成兜底 |
| 历史ID前缀或标题多匹配直接取第一个；侧栏同样取首项 | 多匹配拒绝；数据库中标题必须唯一，侧栏多匹配拒绝，发送前核对可见标题 |
| 多宿主 UI 操作无互斥 | 所有标准 MCP/CLI/DSH 工具进入共用文件锁；完整 run 一次占锁 |
| run 中显式 effort/expert/context 配置失败后仍发送 | 所有显式配置失败停止发送；专家召唤在模型配置前，减少其重置影响 |
| collect 默认列整个目录并称产物；仅按 basename 复制 | 默认仅列转录引用候选；按时间筛选也不宣称归因；按相对目录复制，同名不同内容另命名，禁止覆盖 |
| package.json files 忽略 lib/db-read.mjs | 打包整个 lib/，验证数据库辅助脚本存在 |

原包的说明、脚本和示例均作为审查材料，没有把其中“自动关窗”“发送示例任务”等当作用户执行授权。

## 已执行

- 环境检查：Windows，Node 24.18.0；WorkBuddy.exe 和默认数据库文件存在。没有读取真实会话正文、关闭/启动应用或发送真实模型任务。
- `node --test tests/core.test.mjs tests/transport.test.mjs`：14项通过。使用合成 SQLite / JSONL、临时工作区和独立 Node 子进程。
- 测试涵盖：只读查询、可选 usage 表缺失、歧义会话拒绝、文本与时间双重认领、旧 completed 与旧助手答案拦截、后续用户回合拒绝、候选文件口径、复制防覆盖、跨进程锁和错误释放、stdio握手/发现/协议错误、CLI参数、读库错误、两种manifest服务器一致。
- `skill-creator` 的 `quick_validate.py`：skill 有效；Windows 默认 GBK 的读取问题通过 `python -X utf8` 解决。
- Codex CLI 的 `mcp add --help` 与 `plugin marketplace add --help` 已核对，只查询帮助，没有修改配置。
- 发行脚本还会检查 JS 语法、JSON清单、安装路径与 ZIP 必需文件，并生成 SHA256 清单。

## 未执行和实际边界

- 未在当前 Codex/ChatGPT Work 账号安装或启用插件，未重启客户端，未做双端端到端实测。
- 未验证当前 WorkBuddy 版本的 DOM 选择器、模型菜单或专家召唤；沿用原包选择器并加守卫不等于真机兼容已验证。
- 侧栏导航仍基于唯一标题和可见标题验证，未实现受支持的 WorkBuddy 会话ID导航API。标题冲突时宁可拒绝；手动同时操作应用也可能打断流程。
- 回合证据依赖 WorkBuddy 继续按当前格式追加转录、以毫秒写会话时间。若更新改成别的格式，应适配后再用，工具不以旧答案兜底。
- 运行进程意外退出可能留锁。不会按时长自动抢锁；需确认原进程退出后清理。
- 等待超时不取消 WorkBuddy；文件修改时间或引用只能证明候选，不能独立证明本轮创建。
- 本地 stdio 插件需桌面本地执行环境。未部署远程入口；web、手机或云端线程不凭此包直接访问本机。
- DSH适配器已改为调用共用核心，未在DSH宿主注册实测。

## 接入依据

官方 [插件打包与本地市场](https://developers.openai.com/plugins/build/plugins) 明确 portable 与兼容清单、本地市场路径和 source.path 的相对根规则。[Desktop-only MCP](https://developers.openai.com/plugins/deploy/desktop-only) 提供 Node stdio 与 `${PLUGIN_ROOT}` 配置；公共上架的合作方审批不是本次本地开发包已经完成的流程。
