# pi-crew

> 给 pi 配的船员派遣插件 · native-async subagents for [Pi](https://github.com/earendil-works/pi)

把活派给 **pi 自己**——每个船员是一个无头 pi 子进程（`--mode json -p`），跟你用同一套模型、凭据、技能、MCP 和 AGENTS.md，但上下文全新、用完即焚。作业交给 [pi-async-jobs](https://github.com/dong615119371/pi-async-jobs) 托管：作业号、日志、可杀、重启不丢、结果作为消息自动送回。

```
主会话 ── crew_async ──► async-jobs 引擎 ──► pi --mode json -p --no-session（船员）
   ▲                                                    │
   └────────────── 结果作为消息送回 ◄───────────────────┘
```

## 角色

角色档案就是 `~/.pi/agent/agents/*.md`——和 pi 内置 Agent 工具、官方 subagent 示例读的是**同一批文件**，一套档案三处通用。frontmatter 的 `tools` 成为子进程的工具白名单，`model` 成为船员的模型；正文是人格。每次派活现读目录，改完即生效。

## 安装

需要已安装 [pi-async-jobs](https://github.com/dong615119371/pi-async-jobs)。

```bash
pi install git:github.com/dong615119371/pi-crew@v0.1.1
```

## 用法

模型会看到 `crew_async` 工具（装了 async-jobs 时自动激活）：

```
crew_async {
  tasks: [
    { role: "scout", task: "找出所有鉴权相关代码，汇报文件与行号" },
    { role: "worker", task: "把 src/ 下所有 var 换成 const，跑通测试后结束", cwd: "D:/abs/path" }
  ]
}
```

- 并行上限 8，单任务超时默认 30 分钟
- 结果不轮询：每个船员跑完会作为消息自动回来
- 船员不能再生船员（`PI_CREW_GUARD` 护栏）

## 与 pi-delegate 的分工

| | pi-crew | pi-delegate |
| --- | --- | --- |
| 船员大脑 | pi（你的模型池） | OpenCode CLI（免费模型池） |
| 配置 | 完整继承 pi（技能/MCP/AGENTS.md） | OpenCode 自己的配置 |
| 适合 | 要质量的执行与侦察 | 白嫖免费劳动力的粗活 |

## 致谢

角色发现与命令形态来自 pi 官方 [subagent 示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent)；异步骨架与宿主协议来自 [pi-delegate](https://github.com/dong615119371/pi-delegate) / [pi-async-jobs](https://github.com/dong615119371/pi-async-jobs)。

## License

MIT
