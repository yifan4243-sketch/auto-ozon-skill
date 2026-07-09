# auto-ozon-skill

本项目是面向 Ozon 卖家的 TypeScript / Node.js 20+ 自动化 monorepo。当前已落地的生产级模块是 1688 采集适配器。

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

## 风控

本项目不绕过 1688 风控，不接打码平台，不自动处理滑块或验证码。遇到风控时使用 `--headed` 打开浏览器，由人工完成验证。
