# Auto Ozon Skill

一个面向 Ozon 卖家的本地自动化项目：从 1688 找货和深度采集开始，完成商品标准化、Ozon 类目判断、CEL 成本定价、属性填写、俄语草稿生成，并在明确启用的本地店铺配置下提交到 Ozon。

项目首先是一个可靠的 **1688 商品采集工具**，同时提供一条可恢复、可审计的 Ozon 上架链路。所有业务产物保留在本机；店铺 API Key、1688 Cookie 与生图模型密钥不进入 Git。

俄语文案、类目判断、属性语义选择等由当前 Agent 自身完成，不需要客户配置任何文本 LLM、Base URL 或 LLM API Key。只有客户明确要生成商品图时，才需要单独配置生图模型 API。

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 1688 深度采集 | 关键词、图片、指定商品 ID、官方找同款；搜索后自动读取商品详情、SKU、价格、规格、图片与包装事实。 |
| 账号与风控协作 | 多账号 Profile、登录状态诊断、调试日志；遇到滑块或验证码时以可视浏览器交给人工完成。 |
| 俄罗斯市场选品 | 根据本地全年 Ozon 类目数据、竞争度、季节和生活场景规划 5–10 个类目，再用类目名到 1688 找货。 |
| Ozon 类目与属性 | 检索类目、验证类目 ID 组合、按 SKU 分组、读取类目属性与字典值，并保留快照。 |
| 成本与定价 | 使用 CEL 物流规则、1688 采购价、包装数据、汇率和 Ozon 佣金计算到俄成本与售价。 |
| 俄语内容与草稿 | 脚本填写确定性属性，Agent 只在真实事实和字典候选范围内补全俄语名称、简介、标签等字段；生成可直接导入的 `items[]` 草稿。 |
| Ozon 上架 | 只向预先启用的本地店铺提交，轮询导入任务、保留逐 SKU 成功/失败结果、可恢复轮询与可恢复失败重试。 |
| 店铺经营数据 | 通过 Ozon MCP 查询商品、订单、财务、库存、广告、内容质量和定价分析。 |

## 核心：1688 采集流程

采集引擎由 [1688-cli](https://github.com/superjack2050/1688-cli) 的采集能力迁移而来，仅保留商品采集，不包含下单、购物车、旺旺聊天或采购操作。

```text
1688 登录 / Profile
        ↓
关键词、图片、商品 ID 或官方找同款
        ↓
搜索候选 + 商品详情深度采集
        ↓
标题、类目路径、属性、SKU、采购价、图片、包装事实
        ↓
CanonicalProduct（供定价、类目与上架步骤使用）
```

采集结果保留的是上架真正需要的事实：1688 链接、中文标题和类目路径、商品属性、SKU 规格/价格/图片、主图和详情图、包装长宽高与原始重量。不会采集购物车、订单、供应商沟通等信息。

## 安装

需要 Node.js 20+、pnpm，以及推荐安装 Google Chrome。没有 Chrome 时，可安装 Playwright 的 Chromium。

**推荐一键安装：**

```powershell
pnpm dlx ozon-master@1.0.0-rc.1 init --agent all
```

该命令会下载仓库、安装依赖、初始化 Ozon MCP、检查 Chrome，并在没有 Chrome 时下载 Playwright Chromium；同时为 Codex、Claude Code 和 Hermes 安装不含密钥的本地 Skill 指针。Node.js 20+ 与 pnpm 是此命令的前提。

```powershell
git clone <你的仓库地址>
cd auto-ozon-skill
corepack enable
pnpm install

# 仅在本机没有 Chrome 时执行
pnpm exec playwright install chromium
```

若要使用 Ozon MCP 的 API 查询能力，还需要初始化其子模块和 Python 环境：

```powershell
git submodule update --init --recursive
cd vendor/ozon-mcp
uv sync
cd ../..
```

## 先登录 1688

建议至少绑定两个已授权的 1688 账号，方便单个账号遇到风控或失效时切换。项目不会绕过验证码；需要验证时使用 `--headed`，由你在浏览器中完成。

```powershell
pnpm exec tsx apps/cli/src/cli.ts 1688 login
pnpm exec tsx apps/cli/src/cli.ts 1688 whoami
pnpm exec tsx apps/cli/src/cli.ts 1688 doctor
```

## 常用采集命令

每一次新采集任务开始前，Agent 都应先确认四项本次任务参数：是否可视化浏览器（默认否，即无头浏览器）、最大 SKU 数、采购价区间，以及遇到验证码时是否跳过当前商品（默认是）。这些是单次任务选择，不会自动覆盖客户的长期配置。

```powershell
# 关键词采集：默认深度读取商品详情
pnpm exec tsx apps/cli/src/cli.ts source keyword "一次性杯子" --max 10 --sku-max 3

# 价格区间筛选：单位为 CNY
pnpm exec tsx apps/cli/src/cli.ts source keyword "马克杯" --max 10 --price-min 20 --price-max 50 --sku-max 3

# 指定一个或多个 1688 商品 ID
pnpm exec tsx apps/cli/src/cli.ts source offers 123456789 987654321

# 以本地图片找货；此命令返回候选，详情由 offers 继续采集
pnpm exec tsx apps/cli/src/cli.ts source image .\product.jpg --max 10

# 仅使用 1688 官方找同款入口
pnpm exec tsx apps/cli/src/cli.ts source similar 123456789 --max 10
```

所有命令可追加 `--json --pretty` 获取结构化结果；采集出现验证时重跑并添加 `--headed`。
无头模式是默认模式；验证码/滑块绝不自动绕过。若客户选择“跳过”，Agent 记录该商品的 `RISK_CONTROL` 后继续下一个候选商品；若客户选择“不跳过”，则使用 `--headed` 等待客户手动完成验证。

## 从采集到上架的 8 步流程

```text
01 1688 采集
02 商品标准化 CanonicalProduct
03 Ozon 类目选择与 SKU 分组
04 CEL 成本定价
05 读取 Ozon 类目属性和字典快照
06 脚本 + Agent 填写属性
07 生成并校验 Ozon 导入草稿 items[]
08 提交 Ozon、轮询并记录每个 SKU 的结果
```

准备草稿不会写入 Ozon：

```powershell
pnpm exec tsx apps/cli/src/cli.ts workflow listing prepare "一次性杯子" --store-id <Client-Id> --sku-max 3 --json --pretty
```

如果客户已配置可选生图模型并希望默认生成 3 张商品图，可增加
`--generate-images`；不增加该参数时只校验并使用合格的 1688 原图：

```powershell
pnpm exec tsx apps/cli/src/cli.ts workflow listing prepare "一次性杯子" --store-id <Client-Id> --sku-max 3 --generate-images --json --pretty
```

批量上架使用持久化批次台账。明确关键词时直接采集；未指定商品时先运行俄罗斯市场选品：

```powershell
pnpm exec tsx apps/cli/src/cli.ts workflow batch create --batch-id batch-001 --store-id <Client-Id> --count 20 --profiles account-1,account-2 --keyword "杯子"
pnpm exec tsx apps/cli/src/cli.ts workflow batch run --batch-id batch-001
pnpm exec tsx apps/cli/src/cli.ts workflow batch status --batch-id batch-001
```

每个商品 run 的完整证据和产物位于：

```text
data/runs/<run_id>/
├── manifest.json
├── 01-source-1688/
├── 02-canonical/
├── 03-category-decision/
├── 04-cost-pricing/
├── 05-category-attributes/
├── 06-attribute-mapping/
├── 07-draft-generation/image-bundle-v1.json
├── 07-draft-generation/listing-draft-v2.json
└── 08-listing-submit/ozon-publish-result-v1.json
```

发布前必须通过本机配置绑定店铺，并明确设置 `publishing.enabled: true`。发布只接受第 7 步状态为 `draft_complete` 的草稿：

```powershell
pnpm exec tsx apps/cli/src/cli.ts workflow listing publish --run-id <run_id> --store-id <Client-Id>
pnpm exec tsx apps/cli/src/cli.ts workflow listing resume --run-id <run_id> --store-id <Client-Id>
pnpm exec tsx apps/cli/src/cli.ts workflow listing status --run-id <run_id>
```

第 8 步不会管理库存，也不会自动删除、下架、归档或回滚商品。成功 SKU 保留；可恢复的失败最多再尝试两次。

## 让 Agent 使用本项目

仓库根目录的 [SKILL.md](SKILL.md) 是总入口。它会把客户自然语言路由为正确流程：

| 客户说法 | Agent 的处理方式 |
| --- | --- |
| “给我上架 20 个杯子” | 直接把“杯子”作为 1688 关键词，不启动市场类目分析。 |
| “给我上架十个商品” | 先做俄罗斯市场选品，分散到多个类目后再采集。 |
| “把店铺上满” | 按店铺每日额度规划；未设置更低额度时按 100 个 SKU 处理。 |
| “绑定店铺 / 修改 SKU 上限 / 修改价格公式” | 使用 [客户配置 Skill](skills/customer-setup/SKILL.md)，只改本地忽略配置。 |

相关专项 Skill：

- [俄罗斯市场选品](skills/ozon-russia-market-selection/SKILL.md)
- [Ozon 类目决策](packages/steps/category-decision/SKILL.md)
- [Ozon 属性填写](packages/steps/attribute-mapping/SKILL.md)
- [成本定价](packages/steps/cost-pricing/SKILL.md)
- [草稿生成](packages/steps/draft-generation/SKILL.md)

## Ozon MCP：查询和经营分析

项目内置 Ozon MCP TypeScript 桥接。它包含约 466 个 Seller / Performance API 方法，以及 13 个已整理的分析工作流，例如订单同步、商品目录同步、财务交易、日销售分析、广告、库存、退货、内容审计与价格分析。

```powershell
pnpm exec tsx apps/cli/src/cli.ts ozon --store-id <Client-Id> doctor
pnpm exec tsx apps/cli/src/cli.ts ozon workflows list
pnpm exec tsx apps/cli/src/cli.ts ozon workflows get pricing_analysis
pnpm exec tsx apps/cli/src/cli.ts ozon methods search "product" --api seller --safety read
pnpm exec tsx apps/cli/src/cli.ts ozon methods describe ProductAPI_GetProductInfoList
```

通用 `ozon call` 和 `ozon fetch-all` 仅允许读操作。商品导入是一个独立的、固定白名单的第 8 步，不允许通过通用 MCP 命令任意写入。

完整说明见：[Ozon MCP 使用说明](references/ozon-mcp-bridge.md)。

## 安全与边界

- 不绕过 1688 风控、滑块或验证码；不使用打码服务。
- 不记录或提交 Cookie、API Key、Token、密码等秘密信息。
- 店铺凭据只保存在 `.env` 或 Git 忽略的本地配置中；界面和日志只显示“已配置”。
- 不支持购物车、下单采购、旺旺聊天、供应商研究、订单履约或后台常驻进程。
- 上架前请先在测试店铺用单 SKU 验证配置与类目规则。

## 开发

```powershell
pnpm typecheck
pnpm test
pnpm build
```

业务步骤在 `packages/steps/`，CLI 在 `apps/cli/`，Ozon MCP 子模块在 `vendor/ozon-mcp/`。更多命令可查看 [docs/COMMANDS.md](docs/COMMANDS.md)。

## 开源交流

本仓库完全开源，欢迎自由使用、提交建议和二次开发。如果它帮助到了你，欢迎点一个 GitHub Star。一起交流 AI 与 Ozon 自动化，可添加作者微信：`ziyi_ozon`（请备注来意）。

## 开源致谢

本项目不是从零开始重复造轮子。感谢开源社区提供了可靠的基础能力，也特别感谢以下项目的作者与贡献者：

- [superjack2050/1688-cli](https://github.com/superjack2050/1688-cli)：本项目的 1688 采集能力基于其优秀的采集思路迁移和适配。它把登录态、真实浏览器交互、商品搜索、详情读取、SKU 解析和风控协作组织得非常清晰，为后续商品自动化提供了扎实基础。
- [PCDCK/ozon-mcp](https://github.com/PCDCK/ozon-mcp)：提供了结构化的 Ozon Seller / Performance API 知识库、Swagger 方法检索、工作流、示例、限流与错误目录。它让 Agent 可以先理解接口契约，再安全地调用正确方法，是本项目 Ozon MCP 桥接的核心参考。
- [Microsoft Playwright](https://playwright.dev/)：提供稳定的跨浏览器自动化能力，使项目可以默认无头采集，并在遇到 1688 验证时切换到可视浏览器，由用户安全地手动处理。

感谢所有维护者持续投入时间和技术能力。Auto Ozon Skill 在这些优秀开源项目之上，专注补齐“1688 采集 → Ozon 类目与定价 → 属性草稿 → 上架与结果记录”的本地化流程。
