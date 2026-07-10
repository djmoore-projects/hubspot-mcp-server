#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HubSpotApiError, HubSpotClient } from "./hubspotClient.js";

const accessToken = process.env.HUBSPOT_ACCESS_TOKEN;
if (!accessToken) {
  console.error(
    "Missing HUBSPOT_ACCESS_TOKEN environment variable. Set it before starting the server."
  );
  process.exit(1);
}

const hubspot = new HubSpotClient(accessToken);

const server = new McpServer({
  name: "hubspot-mcp-server",
  version: "1.0.0",
});

/** Converts any thrown error into a non-throwing MCP tool error response. */
function toToolError(err: unknown) {
  const message =
    err instanceof HubSpotApiError
      ? err.message
      : err instanceof Error
      ? `Unexpected error: ${err.message}`
      : "Unexpected unknown error";

  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function toToolSuccess(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

server.tool(
  "hubspot_get_contact",
  "Look up a HubSpot contact by email address. Returns first name, last name, lifecycle stage, and associated company name.",
  {
    email: z.string().email().describe("The contact's email address to search for."),
  },
  async ({ email }) => {
    try {
      const contact = await hubspot.getContactByEmail(email);
      if (!contact) {
        return toToolSuccess({ found: false, message: `No contact found for email: ${email}` });
      }
      return toToolSuccess({ found: true, contact });
    } catch (err) {
      return toToolError(err);
    }
  }
);

server.tool(
  "hubspot_search_companies",
  "Search HubSpot companies by name or domain. Returns matching company names and domains.",
  {
    query: z.string().min(1).describe("Free-text search query, e.g. a company name or domain."),
  },
  async ({ query }) => {
    try {
      const companies = await hubspot.searchCompanies(query);
      return toToolSuccess({ count: companies.length, companies });
    } catch (err) {
      return toToolError(err);
    }
  }
);

server.tool(
  "hubspot_create_contact",
  "Create a new HubSpot contact, or update an existing one if the email already exists.",
  {
    email: z.string().email().describe("The contact's email address (used as the unique key)."),
    firstName: z.string().optional().describe("The contact's first name."),
    lastName: z.string().optional().describe("The contact's last name."),
    company: z.string().optional().describe("The contact's company name."),
  },
  async ({ email, firstName, lastName, company }) => {
    try {
      const contact = await hubspot.createOrUpdateContact({ email, firstName, lastName, company });
      return toToolSuccess({ contact });
    } catch (err) {
      return toToolError(err);
    }
  }
);

server.tool(
  "hubspot_log_activity",
  "Log an engagement (note, email, or call) on a contact's HubSpot timeline.",
  {
    contactId: z.string().min(1).describe("The HubSpot contact ID to log the activity against."),
    activityType: z
      .enum(["NOTE", "EMAIL", "CALL"])
      .describe("The type of engagement to log."),
    body: z.string().min(1).describe("The text content/body of the activity."),
  },
  async ({ contactId, activityType, body }) => {
    try {
      const result = await hubspot.logActivity({ contactId, activityType, body });
      return toToolSuccess({ logged: true, ...result });
    } catch (err) {
      return toToolError(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HubSpot MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting HubSpot MCP server:", err);
  process.exit(1);
});
