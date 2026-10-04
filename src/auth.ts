import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import type { AppConfig } from "./config.js";
import type { Principal } from "./gateway.js";

/** Normalizes the scope claim across IdPs: `scope` (RFC 9068 / Auth0 / Okta), `scp` (Entra, Okta), `permissions` (Auth0 RBAC). */
function extractScopes(payload: JWTPayload): string[] {
  const scopes = new Set<string>();
  for (const claim of [payload.scope, payload.scp, payload.permissions]) {
    if (typeof claim === "string") claim.split(" ").filter(Boolean).forEach((s) => scopes.add(s));
    else if (Array.isArray(claim)) claim.filter((s) => typeof s === "string").forEach((s) => scopes.add(s));
  }
  return [...scopes];
}

/**
 * Validates access tokens issued by the enterprise IdP for *this* server.
 * The MCP server is an OAuth 2.1 resource server: it never issues tokens and
 * never forwards the caller's token upstream (HubSpot is called with the
 * tenant's own credential), which rules out token passthrough.
 */
export function createJwtVerifier(oauth: AppConfig["oauth"]): OAuthTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(oauth.jwksUri), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer: oauth.issuer,
          audience: oauth.audience, // tokens minted for any other API are rejected
          algorithms: ["RS256", "PS256", "ES256", "EdDSA"],
          clockTolerance: 30,
          requiredClaims: ["exp", "sub"],
        }));
      } catch (err) {
        const reason = err instanceof joseErrors.JOSEError ? err.code : "verification failed";
        throw new InvalidTokenError(`Invalid access token (${reason})`);
      }

      const tenantId = payload[oauth.tenantClaim];
      if (typeof tenantId !== "string" || !tenantId) {
        throw new InvalidTokenError(`Access token is missing the ${oauth.tenantClaim} claim`);
      }

      return {
        token,
        clientId: String(payload.azp ?? payload.client_id ?? payload.cid ?? "unknown"),
        scopes: extractScopes(payload),
        expiresAt: payload.exp,
        extra: { subject: payload.sub, tenantId },
      };
    },
  };
}

export function principalFromAuth(auth: AuthInfo): Principal {
  return {
    tenantId: String(auth.extra?.tenantId),
    subject: String(auth.extra?.subject),
    clientId: auth.clientId,
    scopes: auth.scopes,
  };
}
