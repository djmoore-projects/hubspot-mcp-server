import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ApprovalStore } from "../src/approvals.js";
import { AuditLogger, verifyAuditChain, type AuditRecord } from "../src/audit.js";
import { createJwtVerifier } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { startDevIssuer } from "../src/dev/issuer.js";
import { Gateway } from "../src/gateway.js";
import { createHttpApp } from "../src/http.js";
import { RateLimiter } from "../src/rateLimit.js";
import type { CrmClient } from "../src/tools.js";

const READ = ["hubspot:contacts:read", "hubspot:companies:read"];
const WRITE = [...READ, "hubspot:contacts:write", "hubspot:activities:write"];
const APPROVE = ["hubspot:approvals:review"];

/** Fake CRM per tenant that records every call, so we can prove what did (and didn't) reach HubSpot. */
function fakeCrm(tenant: string, calls: string[]): CrmClient {
  return {
    async getContactByEmail(email) {
      calls.push(`${tenant}:get:${email}`);
      return { id: "101", email, firstName: "Jane", lifecycleStage: "customer" };
    },
    async searchCompanies(query) {
      calls.push(`${tenant}:search:${query}`);
      return [{ id: "1", name: `${tenant} result`, domain: "example.com" }];
    },
    async createOrUpdateContact(input) {
      calls.push(`${tenant}:create:${input.email}`);
      return { id: "202", email: input.email, firstName: input.firstName };
    },
    async logActivity(input) {
      calls.push(`${tenant}:log:${input.contactId}`);
      return { engagementId: "303" };
    },
  };
}

describe("remote HubSpot MCP server", () => {
  let issuer: Awaited<ReturnType<typeof startDevIssuer>>;
  let server: Server;
  let base: string;
  let auditFile: string;
  const calls: string[] = [];

  const token = (sub: string, scopes: string[], tenant = "acme", audience = `${base}/mcp`) =>
    issuer.mint({ sub, tenant, scopes, audience });

  async function connect(bearer: string) {
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } })
    );
    return client;
  }

  const text = (r: any) => JSON.parse(r.content[0].text);

  const api = async (method: string, path: string, bearer: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    issuer = await startDevIssuer();
    auditFile = join(mkdtempSync(join(tmpdir(), "audit-")), "audit.jsonl");

    // Bind first so the audience (resource URL) is known before building config.
    const { createServer } = await import("node:http");
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const config = loadConfig({
      MCP_TRANSPORT: "http",
      PUBLIC_BASE_URL: base,
      OAUTH_ISSUER: issuer.issuer,
      OAUTH_JWKS_URI: issuer.jwksUri,
      TENANTS_JSON: JSON.stringify({ acme: { hubspotTokenEnv: "T_ACME" }, globex: { hubspotTokenEnv: "T_GLOBEX" } }),
      T_ACME: "pat-acme",
      T_GLOBEX: "pat-globex",
      RATE_LIMIT_WRITE_PER_MIN: "3",
      AUDIT_LOG_FILE: auditFile,
    });
    const audit = new AuditLogger({ ...config.audit, stderr: false });
    const limiter = new RateLimiter();
    const approvals = new ApprovalStore(config.approvalTtlSeconds);
    const gateway = new Gateway({ getClient: (t) => fakeCrm(t, calls), audit, limiter, approvals, config });
    server.on("request", createHttpApp({ config, verifier: createJwtVerifier(config.oauth), gateway, audit, limiter, approvals }));
  });

  after(() => {
    server.close();
    issuer.close();
  });

  it("rejects missing tokens with a discoverable 401", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="[^"]+oauth-protected-resource\/mcp"/);

    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${base}/mcp`);
    assert.deepEqual(prm.authorization_servers, [issuer.issuer]);
  });

  it("rejects tokens minted for a different audience", async () => {
    const t = await token("agent@acme.test", WRITE, "acme", "https://some-other-api.example.com");
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${t}` }, body: "{}" });
    assert.equal(res.status, 401);
  });

  it("rejects tokens for an unknown tenant", async () => {
    const t = await token("x@evil.test", WRITE, "evilcorp");
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${t}` }, body: "{}" });
    assert.equal(res.status, 403);
  });

  it("rejects browser origins that are not allow-listed", async () => {
    const t = await token("agent@acme.test", WRITE);
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${t}`, Origin: "https://evil.example" }, body: "{}" });
    assert.equal(res.status, 403);
  });

  it("only exposes tools the caller is scoped for", async () => {
    const reader = await connect(await token("analyst@acme.test", READ));
    const names = (await reader.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["hubspot_get_contact", "hubspot_search_companies"]);

    const r = await reader.callTool({ name: "hubspot_create_contact", arguments: { email: "a@b.co" } });
    assert.equal(r.isError, true);
    assert.ok(!calls.some((c) => c.includes("create")));
    await reader.close();
  });

  it("routes each tenant to its own CRM", async () => {
    const globex = await connect(await token("u@globex.test", READ, "globex"));
    const r = text(await globex.callTool({ name: "hubspot_search_companies", arguments: { query: "x" } }));
    assert.equal(r.companies[0].name, "globex result");
    assert.ok(calls.includes("globex:search:x"));
    await globex.close();
  });

  it("holds writes for human approval, enforces four-eyes, then executes the frozen args", async () => {
    const agent = await connect(await token("agent@acme.test", WRITE));
    const pending = text(
      await agent.callTool({ name: "hubspot_create_contact", arguments: { email: "jane@bank.test", firstName: "Jane" } })
    );
    assert.equal(pending.status, "pending_approval");
    assert.ok(!calls.includes("acme:create:jane@bank.test"), "write must not reach HubSpot before approval");

    // The requester cannot approve their own action, even if they also hold the approver scope.
    const selfApprove = await api("POST", `/approvals/${pending.approvalId}/approve`, await token("agent@acme.test", [...WRITE, ...APPROVE]));
    assert.equal(selfApprove.status, 403);

    // A non-approver cannot see the queue; an approver in another tenant cannot see the request.
    assert.equal((await api("GET", "/approvals", await token("analyst@acme.test", READ))).status, 403);
    assert.equal((await api("POST", `/approvals/${pending.approvalId}/approve`, await token("boss@globex.test", APPROVE, "globex"))).status, 404);

    const approverToken = await token("approver@acme.test", APPROVE);
    const queue = await api("GET", "/approvals", approverToken);
    assert.equal(queue.body.approvals[0].args.email, "jane@bank.test");

    const approved = await api("POST", `/approvals/${pending.approvalId}/approve`, approverToken, { reason: "KYC verified" });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "executed");
    assert.ok(calls.includes("acme:create:jane@bank.test"));

    // Double approval is refused.
    assert.equal((await api("POST", `/approvals/${pending.approvalId}/approve`, approverToken)).status, 409);

    const status = text(await agent.callTool({ name: "hubspot_get_approval_status", arguments: { approvalId: pending.approvalId } }));
    assert.equal(status.status, "executed");
    assert.equal(status.decidedBy, "approver@acme.test");
    await agent.close();
  });

  it("rejected writes never execute", async () => {
    const agent = await connect(await token("agent2@acme.test", WRITE));
    const pending = text(
      await agent.callTool({ name: "hubspot_log_activity", arguments: { contactId: "101", activityType: "NOTE", body: "wire $1M" } })
    );
    const rejected = await api("POST", `/approvals/${pending.approvalId}/reject`, await token("approver@acme.test", APPROVE), { reason: "no" });
    assert.equal(rejected.body.status, "rejected");
    assert.ok(!calls.includes("acme:log:101"));
    await agent.close();
  });

  it("rate limits writes per user", async () => {
    const agent = await connect(await token("burst@acme.test", WRITE));
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await agent.callTool({ name: "hubspot_create_contact", arguments: { email: `b${i}@bank.test` } }));
    }
    assert.equal(results.filter((r) => r.isError).length, 1);
    assert.match((results[3] as any).content[0].text, /Rate limit exceeded/);
    await agent.close();
  });

  it("writes a tamper-evident, PII-redacted audit trail", () => {
    const records: AuditRecord[] = readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(verifyAuditChain(records), -1);
    assert.ok(records.some((r) => r.action === "approval.executed" && r.outcome === "success"));
    assert.ok(records.some((r) => r.action === "auth.denied" && r.reason === "self-approval blocked"));
    assert.ok(!readFileSync(auditFile, "utf8").includes("jane@bank.test"), "raw emails must not be logged");
    assert.ok(!readFileSync(auditFile, "utf8").includes("wire $1M"), "free-text bodies must not be logged");

    records[1] = { ...records[1], outcome: "success", reason: "edited" };
    assert.equal(verifyAuditChain(records), 1);
  });
});
