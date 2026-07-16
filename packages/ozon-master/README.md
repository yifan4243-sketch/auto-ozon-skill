# ozon-master

安装并配置 [Auto Ozon Skill](https://github.com/yifan4243-sketch/auto-ozon-skill) 的引导工具。

```powershell
pnpm dlx ozon-master init --agent all
```

它会克隆仓库、安装 pnpm 依赖、初始化 Ozon MCP 子模块、检查 Chrome，并在没有可用 Chrome 时下载 Playwright Chromium；随后为 Codex、Claude Code 和/或 Hermes 写入一个不含密钥的本地 Skill 指针。

Node.js 20+ 和 pnpm 是运行这条命令的前提。Git 与 uv 缺失时，工具会给出明确的安装指引；运行 `ozon-master doctor` 可复查环境。

```powershell
pnpm dlx ozon-master doctor --dir .\auto-ozon-skill
pnpm dlx ozon-master init --agent codex --dir D:\Tools\auto-ozon-skill
```

店铺 API Key、1688 登录与模型密钥不会由安装器读取、复制或上传。安装后让 Agent 阅读仓库根目录 `SKILL.md`，按首次配置流程在本机绑定店铺。
