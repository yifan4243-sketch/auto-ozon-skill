# Safety

This project collects product facts and prepares Ozon listings. It does not
automate purchasing, fulfillment, inventory mutation, deletion or unlisting.

## Hard boundaries

Forbidden:

- automatic orders, cart, checkout, supplier chat or Wangwang messages;
- slider, captcha or risk-control bypass and captcha-solving services;
- unbounded retries, daemons or hidden background publishing;
- logging or committing cookies, API keys, tokens, passwords, local databases
  or account state;
- generic Ozon MCP writes, arbitrary operation IDs or arbitrary write URLs;
- real Seller API writes from tests, CI, fixture refreshes or smoke checks.

1688 risk control must be surfaced as a structured, recoverable event. Use a
visible browser and let the authorized customer complete verification manually,
or apply the configured bounded retry/profile-switch policy and skip the offer.

## Secrets and Ozon credential scopes

Local store JSON contains only `SecretRefV1` environment-variable references.
Seller `credentials` and optional `performance_credentials` are separate.
Only the credentials required by the selected store and API family are passed
to an MCP child; the entire ambient environment is never copied. Diagnostics,
logs, review responses and artifacts expose configured/not-configured booleans,
not values.

MCP discovery needs no live credentials. Generic `ozon call` and
`ozon fetch-all` describe the method first and reject `write` or `destructive`
operations. Listing submission is the sole write path and is limited to the
typed import, import-info polling and product-ID readback endpoints.

## Publishing authorization

`publishing.enabled` is a policy switch, not proof of consent. A user must
explicitly enable publishing through setup or the local review console, which
creates `StorePublishingConsentV1`. Publish verifies that the Consent exists,
is enabled and unrevoked, belongs to the store, and still matches the profile.
It then records a separate run/draft-bound execution authorization. Publish
must never create its own Consent. Disabling publishing revokes the active
Consent and prevents later batches.

## Product facts, qualification and images

- Agent output is constrained by versioned risk rules, source evidence, Ozon
  dictionaries and runtime schemas. Uncertain qualification data becomes
  `needs_review` or `blocked`; it is not guessed through publication.
- Packaging priority is 1688 SKU fact, 1688 product fact, explicit user input,
  Agent estimate. Estimates only fill missing data and never overwrite facts.
- Remote images require HTTPS (except explicitly configured local development),
  host allowlisting, DNS/IP checks on every redirect, streaming byte limits and
  bounded timeouts. Private, loopback, metadata and reserved networks are
  rejected.

## Local Review Console

The review console is localhost-only and single-user. It uses an HttpOnly,
SameSite=Strict local session, same-origin CSRF validation, request-size limits,
safe identifiers and strict CSP. Team mode, public hosting, OIDC and multi-node
shared artifacts are unsupported and must not be advertised as production
features.
