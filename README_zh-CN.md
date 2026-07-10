# auto-ozon-skill

本项目是面向 Ozon 卖家的 TypeScript / Node.js 20+ 自动化 monorepo。当前已落地的基础能力包括 1688 采集适配器，以及对 `PCDCK/ozon-mcp` 的完整 TypeScript 桥接。

## 1688 采集能力

1688 采集内核来自 [superjack2050/1688-cli](https://github.com/superjack2050/1688-cli)，已以 TypeScript 源码形式移植到 `packages/adapters-1688`。本项目只保留采集相关能力：

- login / logout / whoami / doctor
- profile list / profile status
- keyword 搜索，默认深度采集商品详情
- image 搜索候选商品，详情采集复用 `offers`
- `offers` 支持任意数量 offerId，统一批量输出
- official similar / 找同款
- debug list / last / show

已彻底删除 daemon / 后台常驻进程逻辑，不支持 `serve` 或后台管理命令。

## 不支持

不支持 cart、checkout、order、seller、supplier、research、compare、feedback，不支持自动下单、购物车操作、订单或物流管理、旺旺聊天。

## Ozon MCP 完整桥

Ozon API 发现和受控只读调用通过外部 [PCDCK/ozon-mcp](https://github.com/PCDCK/ozon-mcp) MCP server 完成。该 Python 项目以 `vendor/ozon-mcp` git submodule 形式接入，不复制、不改写到 `packages/adapters-ozon/src`。

TypeScript 适配器已经覆盖全部 15 个 MCP 工具，包括：接口与板块检索、完整 Schema、示例、关联方法、工作流、限流、错误目录、Swagger 元数据、订阅信息、自动分页和通用 API 调用。

运行时工具数量会根据凭证变化：

- 未配置 Ozon 凭证时，固定提供 12 个发现与参考工具；
- 配置 Seller 或 Performance 凭证后，额外提供 `ozon_call_method` 和 `ozon_fetch_all`；
- 配置 Seller 凭证后，额外提供 `ozon_get_subscription_status`。

```bash
git submodule update --init --recursive
cd vendor/ozon-mcp
uv sync
uv run ozon-mcp --help
cd ../..
pnpm --filter @auto-ozon/cli dev -- ozon doctor --json --pretty
pnpm --filter @auto-ozon/cli dev -- ozon reference swagger-meta --json --pretty
pnpm --filter @auto-ozon/cli dev -- ozon methods search "product import" --api seller --json --pretty
pnpm --filter @auto-ozon/cli dev -- ozon methods describe ProductAPI_ImportProductsV3 --json --pretty
pnpm --filter @auto-ozon/cli dev -- ozon methods examples ProductAPI_ImportProductsV3 --json --pretty
```

当前阶段 Ozon 侧只允许 read 方法。`ozon call` 和 `ozon fetch-all` 会先调用 `ozon_describe_method` 检查 `safety`，遇到 `write` 或 `destructive` 会在本地返回 `OZON_WRITE_BLOCKED`，不会向 Ozon 发出写请求。

完整命令请查看 `docs/COMMANDS.md`。

## 风控

本项目不绕过 1688 风控，不接打码平台，不自动处理滑块或验证码。遇到风控时使用 `--headed` 打开浏览器，由人工完成验证。
