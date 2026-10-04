import { z } from "zod";
import type { HubSpotClient } from "./hubspotClient.js";

/** The subset of HubSpotClient the tools use; lets tests inject a fake CRM. */
export type CrmClient = Pick<
  HubSpotClient,
  "getContactByEmail" | "searchCompanies" | "createOrUpdateContact" | "logActivity"
>;

export const SCOPES = {
  contactsRead: "hubspot:contacts:read",
  companiesRead: "hubspot:companies:read",
  contactsWrite: "hubspot:contacts:write",
  activitiesWrite: "hubspot:activities:write",
  /** Required to approve/reject pending write actions. Never granted to agents. */
  approvalsReview: "hubspot:approvals:review",
} as const;

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  scope: string;
  kind: "read" | "write";
  inputSchema: S;
  run(client: CrmClient, args: z.objectOutputType<S, z.ZodTypeAny>): Promise<unknown>;
}

const defineTool = <S extends z.ZodRawShape>(t: ToolDef<S>) => t as unknown as ToolDef;

export const TOOLS: ToolDef[] = [
  defineTool({
    name: "hubspot_get_contact",
    description:
      "Look up a HubSpot contact by email address. Returns first name, last name, lifecycle stage, and associated company name.",
    scope: SCOPES.contactsRead,
    kind: "read",
    inputSchema: {
      email: z.string().email().describe("The contact's email address to search for."),
    },
    async run(client, { email }) {
      const contact = await client.getContactByEmail(email);
      return contact
        ? { found: true, contact }
        : { found: false, message: `No contact found for email: ${email}` };
    },
  }),
  defineTool({
    name: "hubspot_search_companies",
    description: "Search HubSpot companies by name or domain. Returns matching company names and domains.",
    scope: SCOPES.companiesRead,
    kind: "read",
    inputSchema: {
      query: z.string().min(1).max(200).describe("Free-text search query, e.g. a company name or domain."),
    },
    async run(client, { query }) {
      const companies = await client.searchCompanies(query);
      return { count: companies.length, companies };
    },
  }),
  defineTool({
    name: "hubspot_create_contact",
    description:
      "Create a new HubSpot contact, or update an existing one if the email already exists. " +
      "Write action: when approvals are enabled this returns a pending approval that a human must approve before it runs.",
    scope: SCOPES.contactsWrite,
    kind: "write",
    inputSchema: {
      email: z.string().email().describe("The contact's email address (used as the unique key)."),
      firstName: z.string().max(100).optional().describe("The contact's first name."),
      lastName: z.string().max(100).optional().describe("The contact's last name."),
      company: z.string().max(200).optional().describe("The contact's company name."),
    },
    async run(client, args) {
      return { contact: await client.createOrUpdateContact(args) };
    },
  }),
  defineTool({
    name: "hubspot_log_activity",
    description:
      "Log an engagement (note, email, or call) on a contact's HubSpot timeline. " +
      "Write action: when approvals are enabled this returns a pending approval that a human must approve before it runs.",
    scope: SCOPES.activitiesWrite,
    kind: "write",
    inputSchema: {
      contactId: z.string().regex(/^\d{1,20}$/).describe("The HubSpot contact ID to log the activity against."),
      activityType: z.enum(["NOTE", "EMAIL", "CALL"]).describe("The type of engagement to log."),
      body: z.string().min(1).max(10_000).describe("The text content/body of the activity."),
    },
    async run(client, args) {
      return { logged: true, ...(await client.logActivity(args)) };
    },
  }),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
