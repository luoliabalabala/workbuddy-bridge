# WorkBuddy 桥（dsh-workbuddy-bridge）

让 DSH 里的智能体直接驱动本机 **WorkBuddy**（腾讯 CodeBuddy 桌面端）：挑历史会话或新开任务、选模型、设上下文长度与思考强度、挑专家、把任务丢进去执行，然后取回答案与产物路径。

控制方式不是截图点按，而是通过 WorkBuddy 自带的 Chromium 调试端口（CDP）读写页面 DOM + 只读其 SQLite 数据库，所以定位准、结果可核对。

## 能力一览

| 工具 | 作用 |
| --- | --- |
| `workbuddy_status` | 应用是否在跑、调试端口、当前界面（首页/会话/设置）、当前模型与专家 chip |
| `workbuddy_sessions` | 列历史会话（标题、状态、模型、上下文、思考强度、最后活动时间） |
| `workbuddy_models` | 实时读取模型菜单：内置档位、积分别率、当前选中项 |
| `workbuddy_experts` | 实时读取专家市场：专家名、角色、是否可召唤 |
| `workbuddy_open` | 打开历史会话（按 id / id 前缀 / 标题片段）或新建任务 |
| `workbuddy_configure` | 设置模型 / 思考强度 / 上下文长度 / 专家 |
| `workbuddy_send` | 把任务文本填进输入框并发送（可选等待） |
| `workbuddy_wait` | 等某个会话跑完，取回最终答复 |
| `workbuddy_collect` | 收集产物路径、写结果摘要到指定文件夹 |
| `workbuddy_run` | 一条命令走完：打开 → 配置 → 发送 → 等待 → 收集 |

## 安装

本目录的 `src/` 就是插件包本体（Host 插件，无依赖、无需构建）：

```powershell
# 在 DSH 里执行（或用插件面板「从本地安装」）
plugin_manager install_bundle "D:\DSH-Projects\workbuddy-bridge\src"
```

安装后重启会话或刷新插件即可看到 `workbuddy_*` 工具。

## 前置条件

1. **调试端口由插件自己搞定，不用手动带参数启动**：插件默认连 `127.0.0.1:9222`；端口没开时它自己处理——应用没开就以 `--remote-debugging-port=9222` 拉起，应用开着但没端口（Electron 单实例锁，后启动的带参进程会被忽略）就关掉全部窗口重新拉起，并通过 computer use 的 `launch_app` 完成。唯一会拒绝重启的情况：数据库显示此刻有任务在跑，强杀会丢掉这一轮，此时会报错说明是哪个会话在忙，等它跑完再调即可。撤销这个行为可把插件配置 `autoRestart` 设为 `false`。
2. **computer use 插件启用**（`dsh-computer-use-win` / `mcp__wincu__windows_computer_use_*`），用于启动应用这一动作；其余操作走 CDP，不需要抢占鼠标键盘。
3. 建议把 WorkBuddy 数据目录保持在默认位置 `%USERPROFILE%\.workbuddy`（读 `workbuddy.db` 与 `projects\<slug>\<sessionId>.jsonl`）。

## 典型用法

新建任务，指定模型 / 思考强度 / 上下文 / 专家，跑完并把摘要落到 `output\`：

```json
{
  "task": "在当前工作目录写一份 bridge-check.txt，内容一行 hello，然后一句话说明字节数。",
  "session": "new",
  "model": "DeepSeek-V4-Pro",
  "effort": "超高",
  "contextK": 600,
  "expert": "吴八哥",
  "outputDir": "D:\\DSH-Projects\\workbuddy-bridge\\output\\demo"
}
```

接着上一轮对话继续问（会话 id 前缀即可）：

```json
{
  "task": "这个文件一共多少字节？一句话回答。",
  "session": "59dc7381",
  "model": "DeepSeek-V4-Pro",
  "effort": "超高",
  "contextK": 600
}
```

模型名、专家名都不必背：先 `workbuddy_models`、`workbuddy_experts` 拿到实时清单再填。

## 参数约定

- `model`：模型**显示名**（如 `Hy4`、`DeepSeek-V4.1-Flash`、`claude-opus-5-5`）；写入数据库的是 WorkBuddy 自己的 id（如 `hy4std`）。
- `effort`：`关闭` / `低` / `中` / `高` / `超高`。模型不支持某个档位时会**如实报错**并列出可用档位，不会偷偷降级。
- `contextK`：按模型可选，常见 `300` / `600` / `960` / `1000`（1M）。新建任务和会话内都能设；超出该模型最大档时自动取最大档，`0` 也表示最大档。
- `expert`：专家名（如 `吴八哥`）。只有新建任务能换专家；历史会话里会明确跳过并说明原因。
- `mode`：`auto`（默认，只回报 WorkBuddy 自己写出的文件路径）/ `copy`（在给了 `outputDir` 时额外复制一份）。

## 产物与"不重复存储"

- WorkBuddy 生成的文件留在它自己的工作目录（新任务为 `%USERPROFILE%\WorkBuddy\<yyyy-MM-dd-HH-mm-ss>\`），插件**只回报绝对路径**。
- 给了 `outputDir` 时，只往里写一份 `workbuddy-result-<sessionId>.md` 摘要（任务、状态、答复、产物路径、执行轨迹）。
- 需要另存副本时显式 `mode: "copy"`；已存在且内容一致的文件不会重复复制。

## 排错

| 现象 | 处理 |
| --- | --- |
| 端口连不上 | 插件会自动关窗口重启并带上端口；连试两次仍失败才报 `NO_PORT`，这时看 WorkBuddy 是否被别的实例占住 |
| `NEEDS_RESTART`（有任务在跑） | 该会话正在执行，强杀会丢结果：等它跑完再调，或自行关闭 WorkBuddy |
| `model menu did not open` | 界面停在弹窗/对话框上，先 `workbuddy_status` 看 `view`，必要时 `restart: true` |
| `effort ... not offered` | 该模型档位固定或不支持；换模型或换档位 |
| 等待超时 | 任务可能仍在跑：用 `workbuddy_sessions` 看状态，再 `workbuddy_wait` 续等 |
| `db read failed` | `workbuddy.db` 被占用（SQLite 只读连接重试即可）；连续出现时重启应用 |

## 变更记录

- 1.0.0：首发。CDP 驱动 + 只读数据库；模型/思考强度/上下文面板按模型实际档位读取，超出自动取最大档；专家只在新建任务时可选；默认只回报产物原路径，`mode:"copy"` 才复制且跳过内容一致的重复文件。
- 1.0.2：调试端口完全自动化。工具不再需要 estart:true：端口没开时插件自己以带端口方式拉起，应用开着但没端口时自动关窗口重启；只在数据库显示有任务正在执行时拒绝重启并说明原因。新增配置 utoRestart（默认 	rue）可关掉自动重启；启动后等窗口就绪再读状态。
- 1.0.1：`workbuddy_collect` 支持 id 前缀/标题片段（与其它工具一致）；新建任务的会话识别加了兜底（按 `created_at` 从最近记录里认领），数据库辅助进程补上 `WORKBUDDY_DB` 环境变量，失败原因会写进 trace。

架构与内部实现见 [docs/architecture.md](docs/architecture.md)。
