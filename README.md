# HubSpot MCP Server

[![CI](https://github.com/djmoore-projects/hubspot-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/djmoore-projects/hubspot-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)

A Model Context Protocol (MCP) server that exposes HubSpot CRM data and actions as tools for AI agents (Claude, Cursor, and any other MCP-compatible client) — so an agent can look up a contact, search companies, upsert a lead, and log a call or note, all through typed, validated tool calls instead of hand-rolled API glue.

Battle-tested against a live HubSpot account: contact lookup/upsert, company search, and note logging all verified end-to-end (see [Tools](#tools) for sample I/O).

If you find this useful, a star helps other people building MCP integrations find it.

## Architecture

```
src/
  hubspotClient.ts   HubSpot REST API wrapper (auth, requests, 429 retry, typed responses)
  index.ts           MCP server: tool definitions + stdio transport wiring
```

- **Transport**: `StdioServerTransport` — the server communicates with its MCP client over stdin/stdout, so it's launched as a subprocess (no network port to manage).
- **Auth**: A HubSpot Private App access token is read from the `HUBSPOT_ACCESS_TOKEN` environment variable at startup. The token is never hardcoded or logged.
- **Error handling**: All HubSpot API calls go through `HubSpotClient`, which:
  - Converts network/HTTP failures into a typed `HubSpotApiError` with a client-safe message.
  - Retries `429 Too Many Requests` responses (respecting the `Retry-After` header, with exponential backoff as a fallback) up to 2 times before surfacing the error.
  - Never throws out of a tool handler — `index.ts` catches every error and returns an MCP `isError: true` tool result instead of crashing the server.
- **Tool schemas**: Each tool's input is defined with `zod`, giving strict runtime validation and auto-generated JSON Schema for the MCP client.

## Setup

```bash
cd hubspot-mcp-server
npm install
cp .env.example .env   # then fill in HUBSPOT_ACCESS_TOKEN
npm run build
```

Generate a HubSpot Private App access token: HubSpot → Settings → Integrations → Private Apps → Create a private app. Grant at minimum:
- `crm.objects.contacts.read` / `crm.objects.contacts.write`
- `crm.objects.companies.read`
- `crm.objects.notes.write` (or the relevant engagements scope for the activity types you plan to log)

## Running standalone

```bash
HUBSPOT_ACCESS_TOKEN=pat-xxxxx npm start
```

For local development without a build step:

```bash
HUBSPOT_ACCESS_TOKEN=pat-xxxxx npm run dev
```

## Configuring Claude Desktop

Add this server to your `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hubspot": {
      "command": "node",
      "args": ["/absolute/path/to/hubspot-mcp-server/dist/index.js"],
      "env": {
        "HUBSPOT_ACCESS_TOKEN": "pat-xxxxx"
      }
    }
  }
}
```

Restart Claude Desktop after saving. The four HubSpot tools will appear in the tool picker.

## Tools

### `hubspot_get_contact`
Look up a contact by email.

```json
{ "email": "jane.doe@example.com" }
```

Returns first name, last name, lifecycle stage, and associated company name (if any).

### `hubspot_search_companies`
Search companies by name or domain.

```json
{ "query": "acme" }
```

Returns matching company names and domains.

### `hubspot_create_contact`
Create a contact, or update it if the email already exists.

```json
{
  "email": "jane.doe@example.com",
  "firstName": "Jane",
  "lastName": "Doe",
  "company": "Acme Corp"
}
```

### `hubspot_log_activity`
Log an engagement on a contact's timeline.

```json
{
  "contactId": "12345",
  "activityType": "NOTE",
  "body": "Discussed renewal timeline on the call."
}
```

`activityType` is one of `NOTE`, `EMAIL`, or `CALL`.

## Notes

- Rate limits: HubSpot returns `429` when the account's rate limit is exceeded. The client retries automatically; if retries are exhausted, the tool returns a clear error message rather than crashing.
- All tool errors (invalid input, HubSpot API errors, network failures) are returned as MCP tool errors (`isError: true`) so the calling agent can react instead of the server process dying.

## License

MIT — see [LICENSE](LICENSE).
