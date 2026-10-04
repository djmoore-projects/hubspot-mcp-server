#!/usr/bin/env node
/** Verifies the hash chain of an audit JSONL file: `npm run audit:verify -- ./audit.jsonl` */
import { readFileSync } from "node:fs";
import { verifyAuditChain, type AuditRecord } from "../audit.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: audit:verify <audit.jsonl>");
  process.exit(2);
}
const records: AuditRecord[] = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const broken = verifyAuditChain(records);
if (broken === -1) {
  console.log(`OK: ${records.length} records, chain intact. Head hash ${records.at(-1)?.hash ?? "(empty)"}`);
} else {
  console.error(`TAMPERED: chain breaks at record ${broken} (id ${records[broken].id})`);
  process.exit(1);
}
