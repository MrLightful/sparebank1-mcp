# API provenance

Captured from the public SpareBank 1 developer portal on **2026-10-25**. The portal is a JavaScript application; API catalog metadata and OpenAPI documents are fetched from its own public endpoints:

```text
https://developer.sparebank1.no/api/applicationcatalog/apis/{apiId}
https://developer.sparebank1.no/api/applicationcatalog/resources/{resourceId}/swagger
```

The resource ID is the UUID portion of each file in [openapi/](openapi/). These are source snapshots, not server runtime dependencies. They make request-contract tests reproducible and can be compared with later bank documentation. The server does not fetch or execute portal documentation at runtime.

## Route mapping

All bank calls target `https://api.sparebank1.no`. Account and transaction schemas include `/accounts` and `/transactions` in their path; prefix them with `/personal/banking` once. Transfer schemas contain relative `/debit`, `/creditcard/transferTo` and `/pension` paths; prefix them with `/personal/banking/transfer`.

| Method | Full bank route                                          | Media version | Tool                                             |
| ------ | -------------------------------------------------------- | ------------- | ------------------------------------------------ |
| GET    | `/personal/banking/accounts`                             | v5            | `sb1_list_accounts`                              |
| GET    | `/personal/banking/accounts/{accountKey}`                | v5            | `sb1_get_account`                                |
| GET    | `/personal/banking/accounts/{accountKey}/details`        | v5            | `sb1_get_account_details`                        |
| GET    | `/personal/banking/accounts/keys`                        | v5            | `sb1_get_account_keys`                           |
| POST   | `/personal/banking/accounts/balance`                     | v5            | `sb1_get_account_balance` (read only)            |
| GET    | `/personal/banking/accounts/child/{id}`                  | v5            | `sb1_list_child_accounts`                        |
| GET    | `/personal/banking/transactions`                         | v1            | `sb1_list_transactions`                          |
| GET    | `/personal/banking/transactions/classified`              | v1            | `sb1_list_transactions`, `classified=true`       |
| GET    | `/personal/banking/transactions/{id}/details`            | v1            | `sb1_get_transaction_details`                    |
| GET    | `/personal/banking/transactions/{id}/details/classified` | v1            | `sb1_get_transaction_details`, `classified=true` |
| GET    | `/personal/banking/transactions/export`                  | CSV           | `sb1_export_transactions`                        |
| POST   | `/personal/banking/transfer/debit`                       | v1            | account transfer                                 |
| POST   | `/personal/banking/transfer/creditcard/transferTo`       | v1            | credit-card transfer                             |
| POST   | `/personal/banking/transfer/pension`                     | v1            | pension transfer                                 |
| GET    | `/common/helloworld`                                     | v1            | `sb1_check_connection`                           |

JSON requests use `Accept: application/vnd.sparebank1.vN+json; charset=utf-8`. JSON bodies use the same versioned `Content-Type`. CSV export uses the documented `application/csv;charset=UTF-8` accept value. Array query parameters use repeated keys, as illustrated by the account-key lookup example in the bank schema.

## Documentation limitations

- Regular transactions use query key `accountKey`. The classified endpoint publishes `Account keys`. Both publish `Transaction source`. These are literal, case-sensitive schema names, including spaces, and are encoded with `URLSearchParams`. A bank implementation that differs from its schema will require a verified mapping update; the server does not silently guess undocumented alternatives.
- Export `fields` is documented as a string enum, with no array serialization. The MCP `field` argument accepts one enum value; omitted means the bank’s default columns.
- No list-transactions cursor, offset or completeness indicator is documented. Local coverage metadata is deliberately conservative.
- The portal prose says access tokens last 10 minutes and refresh tokens 365 days, while its example `expires_in` differs. The server uses the actual token endpoint’s numeric `expires_in`; it does not hardcode the example or prose lifetime.
- No PKCE parameter or scope is documented for this personal confidential-client flow. The implementation sends the documented authorization-code and client-secret form parameters and validates a random state. It does not invent PKCE support. BankID stays in the user’s browser.
- Transfer DTOs do not document an idempotency key or a bank dry-run endpoint. Previews validate locally against current account data; they do not reserve funds or quote bank fees.
- This is the personal customer API, not the regulated PSD2/AISP/PISP integration.
