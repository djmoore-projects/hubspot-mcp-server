#!/usr/bin/env node
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApprovalStore } from "./approvals.js";
import { AuditLogger } from "./audit.js";
import { createJwtVerifier } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { Gateway } from "./gateway.js";
import { createHttpApp } from "./http.js";
import { HubSpotClient } from "./hubspotClient.js";
import { RateLimiter } from "./rateLimit.js";
import { TOOLS } from "./tools.js";

/** Lazily builds one HubSpot client per tenant, each with that tenant's own private-app token. */
function tenantClients(config: AppConfig) {
  const cache = new Map<string, HubSpotClient>();
  return (tenantId: string): HubSpotClient => {
    let client = cache.get(tenantId);
    if (!client) {
      const token =
        config.transport === "stdio" ? config.stdioToken : process.env[config.tenants[tenantId]?.hubspotTokenEnv ?? ""];
      if (!token) throw new Error(`No HubSpot credential configured for tenant ${tenantId}`);
      client = new HubSpotClient(token);
      cache.set(tenantId, client);
    }
    return client;
  };
}

async function main() {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const audit = new AuditLogger(config.audit);
  const limiter = new RateLimiter();
  const approvals = new ApprovalStore(config.approvalTtlSeconds);
  const gateway = new Gateway({ getClient: tenantClients(config), audit, limiter, approvals, config });
  setInterval(() => limiter.sweep(), 60_000).unref();

  if (config.transport === "stdio") {
    // Local single-user mode: the operator's own token, all tool scopes.
    const server = gateway.buildServer({
      tenantId: "local",
      subject: process.env.USER ?? "local",
      clientId: "stdio",
      scopes: TOOLS.map((t) => t.scope),
    });
    await server.connect(new StdioServerTransport());
    console.error("HubSpot MCP server running on stdio");
    return;
  }

  const app = createHttpApp({ config, verifier: createJwtVerifier(config.oauth), gateway, audit, limiter, approvals });
  const httpServer = app.listen(config.port, () => {
    console.error(`HubSpot MCP server listening on :${config.port} — MCP endpoint ${config.resourceUrl}`);
  });
  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal error starting HubSpot MCP server:", err);
  process.exit(1);
});
