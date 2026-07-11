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

### 商品事实采集边界

1688 详情采集层只保留后续选品、类目判断和上架准备需要的事实：offerId 与链接、
页面可见的中文类目路径、中文标题、属性、图片/详情内容、价格与起订量、SKU ID/
规格/价格/图片，以及包装长宽高和原始重量。采集层不再采集或输出 1688 数字类目
ID、供应商身份、收货/发货地区、物流重量、库存、销量和来源体积。V1 与 V2 使用
同一精简边界。

### Ozon 类目决策 V0

类目决策位于 `packages/category-intelligence`。它读取
`CanonicalProductV2`，由 Agent 区分普通变体与混合商品，并从仓库现有的
Ozon 中文类目树选择类目。程序负责验证 description category/type ID 组合、
disabled 状态和完整 SKU 覆盖，输出固定的 `CategoryDecisionV1`。本阶段不获取
Ozon 属性，也不生成或发布商品草稿。

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

## CanonicalProductV2 运行时

四个采集命令默认仍返回 CanonicalProduct V1。只有显式指定
`--schema-version 2` 时，才输出 V2 来源事实合同、运行摘要和确定性完整性报告：

```bash
pnpm --filter @auto-ozon/cli dev -- source keyword "修枝剪" --max 10 --schema-version 2
pnpm --filter @auto-ozon/cli dev -- source offers 123456789 --schema-version 2 --json-v2 --pretty
pnpm --filter @auto-ozon/cli dev -- source offers 123456789 --schema-version 2 --save-dir ../../data/validation/canonical-v2-runs
pnpm --filter @auto-ozon/cli dev -- source normalize-v2 --input C:/path/to/saved-offer.json --method offers
```

`--schema-version 2` 控制商品数据合同版本；`--json-v2` 仍只控制响应信封，
两个参数可以同时使用。`source normalize-v2` 仅接受明确的单个
`OfferResult` 或 `OfferBatchResult`，无需浏览器、登录或网络即可离线回放。

V2 保存 keyword 搜索词和 similar 种子 offerId，为后续类目处理提供来源上下文。
未来类目 Agent 将使用搜索词、中文标题、1688 中文类目路径、商品属性和 SKU 规格，
去匹配已经保存的 Ozon 中文类目表；本阶段不实现或运行该 Agent。1688 原始品牌
属性仅作为普通商品属性保留，系统不判断品牌归属或授权。禁售和物流禁运规则仍由
后续用户知识库阶段处理。

人工真实数据验证流程见 `docs/CANONICAL_V2_REAL_VALIDATION.md`。本地验证结果目录
`data/validation/canonical-v2-runs/` 已加入 `.gitignore`。

## 风控

本项目不绕过 1688 风控，不接打码平台，不自动处理滑块或验证码。遇到风控时使用 `--headed` 打开浏览器，由人工完成验证。
