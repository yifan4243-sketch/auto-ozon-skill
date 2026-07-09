# Safety

This project does not automate purchasing or fulfillment.

Forbidden:

- automatic orders
- cart operations
- checkout operations
- seller chat
- reading or sending Wangwang messages
- order and logistics management
- slider, captcha, or risk-control bypass
- captcha-solving services
- unlimited retries
- logging sensitive cookies, tokens, accounts, or credentials

Risk control must be surfaced as:

```json
{
  "code": "RISK_CONTROL",
  "message": "1688 risk control or verification required. Run with --headed and complete verification manually.",
  "recoverable": true
}
```

Use `--headed` and complete verification manually when 1688 requests it.
