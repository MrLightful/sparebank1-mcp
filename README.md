# SpareBank 1 MCP

> [!WARNING]
> Independent project, not affiliated with, endorsed by, or certified by SpareBank 1.

Local MCP server for SpareBank 1 personal banking: accounts, balances, transactions, CSV exports, and optional transfers between your own accounts, including credit cards and pensions.

Requires **Node.js 22+**, a SpareBank 1 customer account, and a [personal API client](https://developer.sparebank1.no/#/documentation/gettingstarted).

## Setup

Register your API client with the exact redirect URI below, then set credentials in your local terminal and log in:

```sh
export SB1_CLIENT_ID="your-client-id"
export SB1_CLIENT_SECRET="your-client-secret"
export SB1_REDIRECT_URI="http://127.0.0.1:8765/callback"
npx -y sparebank1-mcp@0.0.1 login
```

Open the printed URL and complete BankID. Automatic login needs a registered loopback URL such as `http://127.0.0.1:8765/callback`. For an HTTPS redirect, add `--manual` and paste the full redirect URL into the terminal. Keep credentials and callback URLs out of chat.

Add this to your MCP client's configuration using the same credentials and redirect URI:

```json
{
  "mcpServers": {
    "sparebank1": {
      "command": "npx",
      "args": ["-y", "sparebank1-mcp@0.0.1"],
      "env": {
        "SB1_CLIENT_ID": "your-client-id",
        "SB1_CLIENT_SECRET": "your-client-secret",
        "SB1_REDIRECT_URI": "http://127.0.0.1:8765/callback"
      }
    }
  }
}
```

Restart the client and ask: **“Show my accounts and available balances.”**

The server provides 11 read tools for authentication status, accounts, and transactions. See the [tool and endpoint reference](docs/api.md) and [configuration options](.env.example).

## Transfers

Transfers are disabled by default. To enable them, add these entries to the MCP configuration's `env` object and restart the client:

```json
{
  "SB1_ENABLE_TRANSFERS": "true",
  "SB1_MAX_TRANSFER_AMOUNT": "10000.00"
}
```

`sb1_preview_transfer` creates a preview valid for five minutes. `sb1_confirm_transfer` submits it after explicit approval in a trusted client's MCP form elicitation UI. The limit applies per transfer in the source currency, not per day.

Transfer submissions are never retried automatically. If the outcome is unknown, check online banking before attempting another transfer. A submission receipt does not guarantee settlement.

## Local commands

```sh
npx -y sparebank1-mcp@0.0.1 status
npx -y sparebank1-mcp@0.0.1 logout
```

Tokens refresh automatically and are stored as plaintext in `~/.config/sparebank1-mcp/tokens.json` with mode `0600`. `logout` deletes local tokens; stop running server instances afterward. Revoke bank authorization separately in the developer portal. Banking data is shared with your MCP client and may enter its model context.

## Development

From the repository root:

```sh
npm ci
npm run check
node dist/index.js login
```

Use the environment variables from Setup, or copy `.env.example` to `.env`, run `chmod 600 .env`, and launch with `node --env-file=.env dist/index.js`. Add `login` for BankID authentication. For MCP clients, use your Node executable and the absolute path to `dist/index.js` in place of `npx`.
