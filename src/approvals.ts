import { createHash, randomUUID } from "node:crypto";

export type ApprovalStatus = "pending" | "executing" | "executed" | "failed" | "rejected" | "expired";

export interface ApprovalRequest {
  id: string;
  tenantId: string;
  requestedBy: string;
  clientId: string;
  tool: string;
  /** The exact, validated arguments that will run if approved. Never re-read from the agent. */
  args: Record<string, unknown>;
  argsHash: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  result?: unknown;
  error?: string;
}

/**
 * In-memory approval store, scoped by tenant on every read. Swap for a
 * Redis/Firestore/Postgres implementation of the same shape to run multiple instances.
 */
export class ApprovalStore {
  private readonly items = new Map<string, ApprovalRequest>();

  constructor(private readonly ttlSeconds: number, private readonly now: () => number = Date.now) {}

  create(input: Pick<ApprovalRequest, "tenantId" | "requestedBy" | "clientId" | "tool" | "args">): ApprovalRequest {
    const created = this.now();
    const req: ApprovalRequest = {
      ...input,
      id: `apr_${randomUUID()}`,
      argsHash: createHash("sha256").update(JSON.stringify(input.args)).digest("hex"),
      status: "pending",
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + this.ttlSeconds * 1000).toISOString(),
    };
    this.items.set(req.id, req);
    return req;
  }

  /** Tenant-scoped lookup: a request from another tenant is indistinguishable from a missing one. */
  get(tenantId: string, id: string): ApprovalRequest | undefined {
    const req = this.items.get(id);
    if (!req || req.tenantId !== tenantId) return undefined;
    if (req.status === "pending" && Date.parse(req.expiresAt) <= this.now()) req.status = "expired";
    return req;
  }

  list(tenantId: string, status?: ApprovalStatus): ApprovalRequest[] {
    return [...this.items.values()]
      .map((r) => this.get(tenantId, r.id))
      .filter((r): r is ApprovalRequest => !!r && (!status || r.status === status));
  }
}
