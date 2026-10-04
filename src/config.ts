import { readFileSync } from "node:fs";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  PORT: z.coerce.number().int().positive().default(8080),

  // --- Remote (http) mode ---
  /** Public URL of this server, e.g. https://hubspot-mcp.example.com. The MCP endpoint is `${PUBLIC_BASE_URL}/mcp`. */
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** Issuer of the enterprise IdP (Okta, Entra ID, Auth0, Keycloak...). */
  OAUTH_ISSUER: z.string().url().optional(),
  /** JWKS endpoint of the IdP. Defaults to `${OAUTH_ISSUER}/.well-known/jwks.json`. */
  OAUTH_JWKS_URI: z.string().url().optional(),
  /** Expected `aud` claim. Defaults to the MCP endpoint URL (RFC 8707 resource indicator). */
  OAUTH_AUDIENCE: z.string().optional(),
  /** Claim holding the tenant id. */
  OAUTH_TENANT_CLAIM: z.string().default("tenant_id"),
  /** Tenant registry as inline JSON, or a path via TENANTS_FILE. */
  TENANTS_JSON: z.string().optional(),
  TENANTS_FILE: z.string().optional(),
  /** Comma-separated browser origins allowed to call /mcp. Requests without an Origin header are unaffected. */
  ALLOWED_ORIGINS: z.string().default(""),

  // --- Guardrails ---
  REQUIRE_APPROVAL: bool.optional(),
  APPROVAL_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  /** Optional Slack-compatible incoming webhook notified when an approval is requested. */
  APPROVAL_WEBHOOK_URL: z.string().url().optional(),
  RATE_LIMIT_READ_PER_MIN: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WRITE_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_TENANT_PER_MIN: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_IP_PER_MIN: z.coerce.number().int().positive().default(300),
  AUDIT_LOG_FILE: z.string().optional(),
  AUDIT_REDACT_PII: bool.default("true"),

  // --- Local (stdio) mode ---
  HUBSPOT_ACCESS_TOKEN: z.string().optional(),
});

const tenantsSchema = z.record(
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "tenant ids must be 1-64 chars of [A-Za-z0-9_-]"),
  z.object({
    name: z.string().optional(),
    /** Name of the env var holding this tenant's HubSpot private-app token (inject via your secret manager). */
    hubspotTokenEnv: z.string(),
  })
);

export type TenantsConfig = z.infer<typeof tenantsSchema>;

export interface AppConfig {
  transport: "stdio" | "http";
  port: number;
  publicBaseUrl: string;
  resourceUrl: string;
  oauth: { issuer: string; jwksUri: string; audience: string; tenantClaim: string };
  tenants: TenantsConfig;
  allowedOrigins: string[];
  requireApproval: boolean;
  approvalTtlSeconds: number;
  approvalWebhookUrl?: string;
  rateLimits: { readPerMin: number; writePerMin: number; tenantPerMin: number; ipPerMin: number };
  audit: { file?: string; redactPii: boolean };
  stdioToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = envSchema.parse(env);
  const isHttp = e.MCP_TRANSPORT === "http";
  const publicBaseUrl = (e.PUBLIC_BASE_URL ?? `http://localhost:${e.PORT}`).replace(/\/$/, "");
  const resourceUrl = `${publicBaseUrl}/mcp`;

  let tenants: TenantsConfig = {};
  if (isHttp) {
    if (!e.OAUTH_ISSUER) throw new Error("OAUTH_ISSUER is required when MCP_TRANSPORT=http");
    const raw = e.TENANTS_JSON ?? (e.TENANTS_FILE ? readFileSync(e.TENANTS_FILE, "utf8") : undefined);
    if (!raw) throw new Error("TENANTS_JSON or TENANTS_FILE is required when MCP_TRANSPORT=http");
    tenants = tenantsSchema.parse(JSON.parse(raw));
    for (const [id, t] of Object.entries(tenants)) {
      if (!env[t.hubspotTokenEnv]) {
        throw new Error(`Tenant "${id}": env var ${t.hubspotTokenEnv} (its HubSpot token) is not set`);
      }
    }
  } else if (!e.HUBSPOT_ACCESS_TOKEN) {
    throw new Error("Missing HUBSPOT_ACCESS_TOKEN environment variable. Set it before starting the server.");
  }

  const issuer = e.OAUTH_ISSUER ?? "";
  return {
    transport: e.MCP_TRANSPORT,
    port: e.PORT,
    publicBaseUrl,
    resourceUrl,
    oauth: {
      issuer,
      jwksUri: e.OAUTH_JWKS_URI ?? `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`,
      audience: e.OAUTH_AUDIENCE ?? resourceUrl,
      tenantClaim: e.OAUTH_TENANT_CLAIM,
    },
    tenants,
    allowedOrigins: e.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    // Approvals need an out-of-band approver endpoint, which only exists in http mode.
    requireApproval: e.REQUIRE_APPROVAL ?? isHttp,
    approvalTtlSeconds: e.APPROVAL_TTL_SECONDS,
    approvalWebhookUrl: e.APPROVAL_WEBHOOK_URL,
    rateLimits: {
      readPerMin: e.RATE_LIMIT_READ_PER_MIN,
      writePerMin: e.RATE_LIMIT_WRITE_PER_MIN,
      tenantPerMin: e.RATE_LIMIT_TENANT_PER_MIN,
      ipPerMin: e.RATE_LIMIT_IP_PER_MIN,
    },
    audit: { file: e.AUDIT_LOG_FILE, redactPii: e.AUDIT_REDACT_PII },
    stdioToken: e.HUBSPOT_ACCESS_TOKEN,
  };
}
