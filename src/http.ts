import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AuditLogger } from "./audit.js";
import type { ApprovalStatus, ApprovalStore } from "./approvals.js";
import { principalFromAuth } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { Gateway } from "./gateway.js";
import type { RateLimiter } from "./rateLimit.js";
import { SCOPES } from "./tools.js";

export interface HttpDeps {
  config: AppConfig;
  verifier: OAuthTokenVerifier;
  gateway: Gateway;
  audit: AuditLogger;
  limiter: RateLimiter;
  approvals: ApprovalStore;
}

export function createHttpApp({ config, verifier, gateway, audit, limiter, approvals }: HttpDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Cloud Run / Fly terminate TLS in front of us

  app.use((_req, res, next) => {
    res.set({
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // RFC 9728 Protected Resource Metadata: tells MCP clients which IdP to get a token from.
  const metadataUrl = `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`;
  const protectedResource = {
    resource: config.resourceUrl,
    authorization_servers: [config.oauth.issuer],
    scopes_supported: Object.values(SCOPES),
    bearer_methods_supported: ["header"],
    resource_name: "HubSpot CRM (MCP)",
  };
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    app.get(path, (_req, res) => {
      res.json(protectedResource);
    });
  }

  // Cheap pre-auth flood guard, keyed by client IP.
  const ipLimit = (req: Request, res: Response, next: NextFunction) => {
    const r = limiter.take(`ip:${req.ip}`, config.rateLimits.ipPerMin);
    if (r.ok) return next();
    res.set("Retry-After", String(r.retryAfterSeconds)).status(429).json({ error: "rate_limited" });
  };

  // MCP spec: servers must validate Origin to prevent DNS-rebinding from browsers.
  const originGuard = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin || config.allowedOrigins.includes(origin)) return next();
    res.status(403).json({ error: "origin_not_allowed" });
  };

  const bearer = requireBearerAuth({ verifier, resourceMetadataUrl: metadataUrl });

  const tenantGuard = (req: Request, res: Response, next: NextFunction) => {
    const p = principalFromAuth(req.auth!);
    if (Object.hasOwn(config.tenants, p.tenantId)) return next();
    audit.log({ action: "auth.denied", outcome: "denied", tenantId: p.tenantId, subject: p.subject, clientId: p.clientId, reason: "unknown tenant" });
    res.status(403).json({ error: "unknown_tenant" });
  };

  const json = express.json({ limit: "256kb" });

  // Stateless Streamable HTTP: a fresh server per request, built for the caller's
  // scopes. No session affinity is needed, so this scales horizontally.
  app.post("/mcp", ipLimit, originGuard, bearer, tenantGuard, json, async (req, res) => {
    const server = gateway.buildServer(principalFromAuth(req.auth!));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.set("Allow", "POST").status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // --- Human approval API (out-of-band; requires hubspot:approvals:review) ---
  const approver = express.Router();
  approver.use(ipLimit, originGuard, bearer, tenantGuard, json);
  approver.use((req, res, next) => {
    if (req.auth!.scopes.includes(SCOPES.approvalsReview)) return next();
    res.status(403).json({ error: "insufficient_scope", scope: SCOPES.approvalsReview });
  });

  approver.get("/", (req, res) => {
    const status = (req.query.status as ApprovalStatus | undefined) ?? "pending";
    res.json({ approvals: approvals.list(principalFromAuth(req.auth!).tenantId, status) });
  });

  approver.get("/:id", (req, res) => {
    const found = approvals.get(principalFromAuth(req.auth!).tenantId, String(req.params.id));
    if (found) res.json(found);
    else res.status(404).json({ error: "not_found" });
  });

  for (const decision of ["approve", "reject"] as const) {
    approver.post(`/:id/${decision}`, async (req, res) => {
      const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 1000) : undefined;
      const out = await gateway.decide(principalFromAuth(req.auth!), String(req.params.id), decision, reason);
      res.status(out.status).json(out.body);
    });
  }
  app.use("/approvals", approver);

  return app;
}
