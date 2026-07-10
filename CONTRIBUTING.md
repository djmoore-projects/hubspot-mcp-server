# Contributing

Contributions are welcome — bug reports, new HubSpot tools (deals, tickets, pipelines, etc.), and general robustness improvements are all in scope.

## Development setup

```bash
git clone https://github.com/djmoore-projects/hubspot-mcp-server.git
cd hubspot-mcp-server
npm install
cp .env.example .env   # add your own HubSpot private app token
npm run dev
```

## Before opening a PR

- `npx tsc --noEmit` passes with no errors.
- `npm run build` succeeds.
- New tools follow the existing pattern in `src/index.ts`: a `zod` input schema, a call into `HubSpotClient`, and errors returned via the shared `toToolError` helper (never thrown out of a tool handler).
- Update `README.md` with the new tool's schema and a sample input if you add one.

## Reporting bugs

Open an issue with the tool name, the input you sent, and the error/response you got back. Redact your access token and any real contact/company data.
