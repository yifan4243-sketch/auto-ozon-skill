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
```

Global output flags are available on subcommands: `--json`, `--json-v2`, `--pretty`, `--get`, `--pick`.

Not supported: `serve`, background management, `research`, `compare`, `supplier`, `cart`, `checkout`, `order`, `seller`, `feedback`.

`source keyword` always performs deep detail collection. The old external `--deeppro` flags are not exposed.
