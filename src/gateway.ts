import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { redactArgs, type AuditLogger } from "./audit.js";
import type { ApprovalRequest, ApprovalStore } from "./approvals.js";
import type { AppConfig } from "./config.js";
import { HubSpotApiError } from "./hubspotClient.js";
import type { RateLimiter } from "./rateLimit.js";
import { SCOPES, TOOLS, TOOLS_BY_NAME, type CrmClient, type ToolDef } from "./tools.js";

/** The authenticated caller. In http mode this comes from the verified OAuth token. */
export interface Principal {
  tenantId: string;
  subject: string;
  clientId: string;
  scopes: string[];
}

export interface GatewayDeps {
  getClient: (tenantId: string) => CrmClient;
  audit: AuditLogger;
  limiter: RateLimiter;
  approvals: ApprovalStore;
  config: Pick<AppConfig, "requireApproval" | "rateLimits" | "approvalWebhookUrl" | "publicBaseUrl">;
}

type ToolResult = { isError?: true; content: { type: "text"; text: string }[] };

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

function errorMessage(err: unknown): string {
  if (err instanceof HubSpotApiError) return err.message;
  return err instanceof Error ? `Unexpected error: ${err.message}` : "Unexpected unknown error";
}

/**
 * Every tool call passes through here: scope check -> rate limit -> (write) human
 * approval -> execution -> audit. Nothing reaches HubSpot without passing all of them.
 */
export class Gateway {
  constructor(private readonly deps: GatewayDeps) {}

  /** Builds an MCP server exposing only the tools this principal is scoped for. */
  buildServer(p: Principal): McpServer {
    const server = new McpServer({ name: "hubspot-mcp-server", version: "2.0.0" });

    for (const tool of TOOLS) {
      if (!p.scopes.includes(tool.scope)) continue;
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            readOnlyHint: tool.kind === "read",
            destructiveHint: false,
            openWorldHint: true,
          },
        },
        (args: Record<string, unknown>) => this.invoke(p, tool, args)
      );
    }

    if (this.deps.config.requireApproval && TOOLS.some((t) => t.kind === "write" && p.scopes.includes(t.scope))) {
      server.registerTool(
        "hubspot_get_approval_status",
        {
          description:
            "Check the status of a write action awaiting human approval. Returns pending, executed (with the result), failed, rejected, or expired.",
          inputSchema: { approvalId: z.string().regex(/^apr_[0-9a-f-]{36}$/) },
          annotations: { readOnlyHint: true },
        },
        ({ approvalId }) => this.approvalStatus(p, approvalId)
      );
    }
    return server;
  }

  async invoke(p: Principal, tool: ToolDef, args: Record<string, unknown>): Promise<ToolResult> {
    const { audit, approvals, config } = this.deps;
    const who = { tenantId: p.tenantId, subject: p.subject, clientId: p.clientId, tool: tool.name, args };

    // Defense in depth: tools are only registered for scoped principals, but re-check at call time.
    if (!p.scopes.includes(tool.scope)) {
      audit.log({ action: "tool.call", outcome: "denied", reason: `missing scope ${tool.scope}`, ...who });
      return fail(`Forbidden: this action requires the ${tool.scope} scope.`);
    }

    const limited = this.rateLimit(p, tool.kind);
    if (limited) {
      audit.log({ action: "tool.call", outcome: "rate_limited", reason: limited, ...who });
      return fail(limited);
    }

    if (tool.kind === "write" && config.requireApproval) {
      const req = approvals.create({
        tenantId: p.tenantId,
        requestedBy: p.subject,
        clientId: p.clientId,
        tool: tool.name,
        args,
      });
      audit.log({ action: "approval.requested", outcome: "pending", approvalId: req.id, ...who });
      void this.notifyApprovers(req);
      return ok({
        status: "pending_approval",
        approvalId: req.id,
        expiresAt: req.expiresAt,
        message:
          "This write action has NOT been executed. It is waiting for a human approver. " +
          "Tell the user it is pending, and check back later with hubspot_get_approval_status.",
      });
    }

    const started = Date.now();
    try {
      const result = await tool.run(this.deps.getClient(p.tenantId), args);
      audit.log({ action: "tool.call", outcome: "success", durationMs: Date.now() - started, ...who });
      return ok(result);
    } catch (err) {
      const message = errorMessage(err);
      audit.log({ action: "tool.call", outcome: "error", reason: message, durationMs: Date.now() - started, ...who });
      return fail(message);
    }
  }

  private rateLimit(p: Principal, kind: "read" | "write"): string | undefined {
    const { limiter, config } = this.deps;
    const perUser = kind === "read" ? config.rateLimits.readPerMin : config.rateLimits.writePerMin;
    for (const [key, limit] of [
      [`tenant:${p.tenantId}`, config.rateLimits.tenantPerMin],
      [`user:${p.tenantId}:${p.subject}:${kind}`, perUser],
    ] as const) {
      const r = limiter.take(key, limit);
      if (!r.ok) return `Rate limit exceeded (${key.split(":")[0]} ${kind}). Retry after ${r.retryAfterSeconds}s.`;
    }
    return undefined;
  }

  private approvalStatus(p: Principal, approvalId: string): ToolResult {
    const req = this.deps.approvals.get(p.tenantId, approvalId);
    if (!req || (req.requestedBy !== p.subject && !p.scopes.includes(SCOPES.approvalsReview))) {
      return fail(`Approval ${approvalId} not found.`);
    }
    const { id, tool, status, createdAt, expiresAt, decidedBy, decidedAt, reason, result, error } = req;
    return ok({ approvalId: id, tool, status, createdAt, expiresAt, decidedBy, decidedAt, reason, result, error });
  }

  /**
   * A human approver's decision, received out-of-band over authenticated HTTP —
   * deliberately not an MCP tool, so an agent can never approve its own writes.
   */
  async decide(
    approver: Principal,
    approvalId: string,
    decision: "approve" | "reject",
    reason?: string
  ): Promise<{ status: number; body: unknown }> {
    const { audit, approvals } = this.deps;
    const base = { tenantId: approver.tenantId, subject: approver.subject, clientId: approver.clientId, approvalId, reason };

    if (!approver.scopes.includes(SCOPES.approvalsReview)) {
      audit.log({ action: "auth.denied", outcome: "denied", ...base, reason: `missing scope ${SCOPES.approvalsReview}` });
      return { status: 403, body: { error: "insufficient_scope", scope: SCOPES.approvalsReview } };
    }
    const req = approvals.get(approver.tenantId, approvalId);
    if (!req) return { status: 404, body: { error: "not_found" } };
    if (req.status !== "pending") return { status: 409, body: { error: `approval is ${req.status}` } };
    if (req.requestedBy === approver.subject) {
      audit.log({ action: "auth.denied", outcome: "denied", ...base, tool: req.tool, reason: "self-approval blocked" });
      return { status: 403, body: { error: "separation_of_duties", message: "Requesters cannot approve their own actions." } };
    }

    // Claim synchronously so a concurrent second decision gets 409 instead of a double execution.
    req.status = decision === "approve" ? "executing" : "rejected";
    req.decidedBy = approver.subject;
    req.decidedAt = new Date().toISOString();
    req.reason = reason;

    if (decision === "reject") {
      audit.log({ action: "approval.rejected", outcome: "success", ...base, tool: req.tool });
      return { status: 200, body: req };
    }

    audit.log({ action: "approval.approved", outcome: "success", ...base, tool: req.tool });
    const tool = TOOLS_BY_NAME.get(req.tool)!;
    const started = Date.now();
    const executedAs = { tenantId: req.tenantId, subject: req.requestedBy, clientId: req.clientId, tool: req.tool, approvalId, args: req.args };
    try {
      req.result = await tool.run(this.deps.getClient(req.tenantId), req.args);
      req.status = "executed";
      audit.log({ action: "approval.executed", outcome: "success", durationMs: Date.now() - started, ...executedAs });
    } catch (err) {
      req.error = errorMessage(err);
      req.status = "failed";
      audit.log({ action: "approval.executed", outcome: "error", reason: req.error, durationMs: Date.now() - started, ...executedAs });
    }
    return { status: 200, body: req };
  }

  private async notifyApprovers(req: ApprovalRequest): Promise<void> {
    const url = this.deps.config.approvalWebhookUrl;
    if (!url) return;
    const review = `${this.deps.config.publicBaseUrl}/approvals/${req.id}`;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          // `text` makes this payload work as-is with Slack/Teams/Google Chat incoming webhooks.
          // PII is redacted; approvers see the full arguments at the authenticated review URL.
          text: `HubSpot write awaiting approval: ${req.tool} requested by ${req.requestedBy} (tenant ${req.tenantId}). Review: ${review}`,
          approval: { id: req.id, tenantId: req.tenantId, tool: req.tool, requestedBy: req.requestedBy, args: redactArgs(req.args), expiresAt: req.expiresAt },
        }),
      });
    } catch (err) {
      console.error(`Approval webhook failed for ${req.id}:`, err instanceof Error ? err.message : err);
    }
  }
}
