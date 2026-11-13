# Champbeam agent connection

This stdio MCP adapter uses the existing Champbeam REST API. It runs in the agent host, not as a new public HTTP server. It does not provision keys, bypass approval or impersonate an organization.

## Setup

Use Node 24 or newer. In this directory run `npm ci`, then configure your MCP client to start `node /absolute/path/to/mcp/server.mjs`. Set `CHAMPBEAM_API_KEY` through the client's secret manager. The optional `CHAMPBEAM_BASE_URL` is an HTTPS origin, default `https://champbeam.com`. Never put a key in a prompt, URL, source file or command argument.

Create a named key in Champbeam Settings, API keys. The key is shown once. Revoking it in Settings immediately stops new adapter requests. Existing keys act as their owner in Personal scope, not as the browser's currently selected organization. Workspace administration is deliberately not exposed. Do not assume an org-scoped key until that API contract is implemented and reviewed.

## Tools

| Tool | Job | Write approval |
|---|---|---|
| `list_shares` | List files or pages for the key owner | Read only |
| `create_link` | Generate a tracked share URL with optional UTM fields | `confirm: true` after user approval |
| `publish_page` | Publish self-contained HTML | `confirm: true` after user approval |
| `upload_file` | Upload base64 bytes and finalize a download link | `confirm: true` after user approval |
| `content_analytics` | Read file/page engagement, 1 to 365 days | Read only |

The upload adapter is capped at 5 MB to keep protocol messages bounded. Larger files use the existing REST init, signed upload, finalize flow. The adapter never sends an API key to a storage host, follows no redirects, and only accepts the configured origin or an HTTPS R2 storage target returned by the API. Inputs are schema-validated and requests have deadlines. Failed writes are not automatically retried, to avoid duplicate shares. A failed upload can leave an unfinalized upload record for the existing expiry sweeper.

## Verification

Start a disposable local Worker with its local D1/R2 and synthetic auth configuration, then run:

```sh
CHAMPBEAM_TEST_URL=http://127.0.0.1:3197 npm test
```

The test refuses non-loopback targets. It creates a synthetic account and key, connects an actual MCP client over stdio, checks confirmation rejection, publishes a page and tracked link, uploads a file, reads lists and analytics, revokes the key and proves rejection. Keys stay in process memory and are not logged. Local test records are not production data.

The Node test is skipped without `CHAMPBEAM_TEST_URL`. A skipped test is not verification.
