# Commands

Supported:

```bash
auto-ozon 1688 login
auto-ozon 1688 logout
auto-ozon 1688 whoami
auto-ozon 1688 doctor
auto-ozon 1688 profile list
auto-ozon 1688 profile status
auto-ozon 1688 debug list
auto-ozon 1688 debug last
auto-ozon 1688 debug show <requestId>

auto-ozon source keyword "收纳盒" --max 10 --json
auto-ozon source image ./product.jpg --max 10 --json
auto-ozon source offers 123456789 987654321 --json
auto-ozon source similar 123456789 --max 10 --json

auto-ozon ozon doctor --json --pretty
auto-ozon ozon methods search "product list" --json --pretty
auto-ozon ozon methods describe ProductAPI_GetProductList --json --pretty
auto-ozon ozon call ProductAPI_GetProductList --params '{"filter":{"visibility":"ALL"}}' --json --pretty
auto-ozon ozon fetch-all ProductAPI_GetProductList --params '{"filter":{"visibility":"ALL"}}' --max-items 10000 --json --pretty
auto-ozon ozon workflows list --json --pretty
auto-ozon ozon workflows get cabinet_health_check --json --pretty
```

Global output flags are available on subcommands: `--json`, `--json-v2`, `--pretty`, `--get`, `--pick`.

Not supported: `serve`, background management, `research`, `compare`, `supplier`, `cart`, `checkout`, `order`, `seller`, `feedback`.

`source keyword` always performs deep detail collection. The old external `--deeppro` flags are not exposed.

Ozon commands are a TypeScript bridge to the external `vendor/ozon-mcp` submodule. The Python engine is not copied into `packages/adapters-ozon/src`. The current Ozon phase is read-only: `call` and `fetch-all` first describe the method and block `write` or `destructive` methods with `OZON_WRITE_BLOCKED`. CLI help must not expose publish, submit, price update, stock update, archive, or delete commands.
