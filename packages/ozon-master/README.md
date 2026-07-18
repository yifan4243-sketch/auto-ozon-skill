# ozon-master

Auto Ozon Skill 的固定版本安装器。正式包只安装 release manifest 中绑定的
Git tag、commit 与内容哈希，不跟随移动的 `main` 分支。

```powershell
pnpm dlx ozon-master@1.0.0-rc.1 init --agent all
```

需要 Node.js 20+ 与 Git。安装器会启用/检查 pnpm、安装依赖、初始化 Ozon
MCP 子模块、检查 Chrome，并在没有 Chrome 时安装 Playwright Chromium。
它只安装 Agent Skill 指针，不复制任何 API Key、Cookie 或账号秘密。

```powershell
pnpm dlx ozon-master@1.0.0-rc.1 doctor --dir .\auto-ozon-skill
```
