import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type AuditAction =
  | "tool.call"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "approval.executed"
  | "auth.denied";

export type AuditOutcome = "success" | "error" | "denied" | "rate_limited" | "pending";

export interface AuditInput {
  action: AuditAction;
  outcome: AuditOutcome;
  tenantId?: string;
  subject?: string;
  clientId?: string;
  tool?: string;
  approvalId?: string;
  args?: Record<string, unknown>;
  reason?: string;
  durationMs?: number;
}

export interface AuditRecord extends AuditInput {
  id: string;
  ts: string;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Pseudonymize fields that are PII or free text. Emails become a stable hash so
 * investigators can still correlate events for one person without the log
 * holding the address itself.
 */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (k === "email" && typeof v === "string") out[k] = `sha256:${sha256(v.trim().toLowerCase()).slice(0, 16)}`;
    else if (["firstName", "lastName", "body"].includes(k) && typeof v === "string") out[k] = `[redacted len=${v.length}]`;
    else out[k] = v;
  }
  return out;
}

function hashRecord(r: Omit<AuditRecord, "hash">): string {
  // Fixed key order so the hash is reproducible by the verifier.
  const { id, ts, prevHash, ...rest } = r;
  return sha256(JSON.stringify({ id, ts, prevHash, ...rest }));
}

/**
 * Append-only, hash-chained audit log. Every record embeds the hash of the
 * previous one, so deleting or editing a line breaks the chain (see verifyAuditChain).
 * Records go to stderr as JSON (picked up by Cloud Logging / Fly log shipping;
 * stdout is reserved for the stdio MCP channel) and optionally to a JSONL file.
 */
export class AuditLogger {
  private prevHash = GENESIS;

  constructor(private readonly opts: { file?: string; redactPii: boolean; stderr?: boolean }) {
    if (opts.file && existsSync(opts.file)) {
      const lines = readFileSync(opts.file, "utf8").trim().split("\n").filter(Boolean);
      const last = lines.at(-1);
      if (last) this.prevHash = (JSON.parse(last) as AuditRecord).hash;
    }
  }

  log(input: AuditInput): AuditRecord {
    const base = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      prevHash: this.prevHash,
      ...input,
      ...(input.args ? { args: this.opts.redactPii ? redactArgs(input.args) : input.args } : {}),
    };
    const record: AuditRecord = { ...base, hash: hashRecord(base) };
    this.prevHash = record.hash;

    const line = JSON.stringify(record);
    if (this.opts.file) appendFileSync(this.opts.file, line + "\n");
    if (this.opts.stderr !== false) {
      process.stderr.write(JSON.stringify({ severity: "NOTICE", logName: "audit", ...record }) + "\n");
    }
    return record;
  }
}

/** Returns the index of the first broken record, or -1 if the chain is intact. */
export function verifyAuditChain(records: AuditRecord[]): number {
  let prev = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const { hash, ...rest } = records[i];
    if (rest.prevHash !== prev || hashRecord(rest) !== hash) return i;
    prev = hash;
  }
  return -1;
}
