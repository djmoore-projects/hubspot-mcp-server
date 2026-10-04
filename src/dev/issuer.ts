/**
 * DEVELOPMENT ONLY: a throwaway OAuth issuer so you can run the remote server
 * locally (and in tests) without an Okta/Entra/Auth0 tenant. It serves a JWKS
 * and mints RS256 access tokens. Keys live in memory and change on every start.
 *
 *   npm run dev:issuer            # prints ready-made tokens for sample users
 */
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { pathToFileURL } from "node:url";

export interface MintOptions {
  sub: string;
  tenant: string;
  scopes: string[];
  audience: string;
  ttlSeconds?: number;
  clientId?: string;
}

export async function startDevIssuer(port = 0) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "dev-key", alg: "RS256", use: "sig" };

  const server: Server = createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const issuer = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;

  const mint = (o: MintOptions) =>
    new SignJWT({ scope: o.scopes.join(" "), tenant_id: o.tenant, azp: o.clientId ?? "dev-agent" })
      .setProtectedHeader({ alg: "RS256", kid: "dev-key" })
      .setIssuer(issuer)
      .setAudience(o.audience)
      .setSubject(o.sub)
      .setIssuedAt()
      .setExpirationTime(`${o.ttlSeconds ?? 3600}s`)
      .sign(privateKey);

  return { issuer, jwksUri: `${issuer}/.well-known/jwks.json`, mint, close: () => server.close() };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.DEV_ISSUER_PORT ?? 9999);
  const audience = process.env.OAUTH_AUDIENCE ?? `http://localhost:${process.env.PORT ?? 8080}/mcp`;
  const tenant = process.env.DEV_TENANT ?? "acme";
  const dev = await startDevIssuer(port);
  const users = {
    "analyst (read-only)": { sub: "analyst@acme.test", scopes: ["hubspot:contacts:read", "hubspot:companies:read"] },
    "agent (read + write)": {
      sub: "agent@acme.test",
      scopes: ["hubspot:contacts:read", "hubspot:companies:read", "hubspot:contacts:write", "hubspot:activities:write"],
    },
    "approver (reviews writes)": { sub: "approver@acme.test", scopes: ["hubspot:approvals:review"] },
  };
  console.log(`Dev issuer running. Start the server with:\n  OAUTH_ISSUER=${dev.issuer} OAUTH_JWKS_URI=${dev.jwksUri}\n`);
  for (const [label, u] of Object.entries(users)) {
    const token = await dev.mint({ ...u, tenant, audience, ttlSeconds: 8 * 3600 });
    console.log(`# ${label} — tenant ${tenant}\n${token}\n`);
  }
}
