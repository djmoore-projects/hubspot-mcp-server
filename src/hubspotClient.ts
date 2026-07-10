import axios, { AxiosInstance, AxiosError, isAxiosError } from "axios";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

/** Thrown for any HubSpot API failure; message is safe to surface to an MCP client. */
export class HubSpotApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "HubSpotApiError";
  }
}

export interface ContactRecord {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  lifecycleStage?: string;
  companyName?: string;
}

export interface CompanyRecord {
  id: string;
  name?: string;
  domain?: string;
}

export type ActivityType = "NOTE" | "EMAIL" | "CALL";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HubSpotClient {
  private readonly http: AxiosInstance;

  constructor(accessToken: string) {
    this.http = axios.create({
      baseURL: HUBSPOT_API_BASE,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    });
  }

  /**
   * Wraps a HubSpot request with 429 retry (respecting Retry-After) and
   * converts axios errors into HubSpotApiError so callers never see raw
   * axios/network exceptions.
   */
  private async request<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!isAxiosError(err)) {
          throw new HubSpotApiError(
            err instanceof Error ? err.message : "Unknown error contacting HubSpot"
          );
        }

        const axiosErr = err as AxiosError<{ message?: string }>;
        const status = axiosErr.response?.status;

        if (status === 429 && attempt < maxRetries) {
          const retryAfterHeader = axiosErr.response?.headers?.["retry-after"];
          const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : 2 ** attempt;
          await delay(Math.max(retryAfterSeconds, 1) * 1000);
          attempt += 1;
          continue;
        }

        const apiMessage = axiosErr.response?.data?.message ?? axiosErr.message;
        throw new HubSpotApiError(
          `HubSpot API error${status ? ` (${status})` : ""}: ${apiMessage}`,
          status,
          status === 429
            ? Number(axiosErr.response?.headers?.["retry-after"] ?? 0) || undefined
            : undefined
        );
      }
    }
  }

  /** Look up a contact by email, including lifecycle stage and associated company name. */
  async getContactByEmail(email: string): Promise<ContactRecord | null> {
    const searchResult = await this.request(() =>
      this.http.post("/crm/v3/objects/contacts/search", {
        filterGroups: [
          {
            filters: [{ propertyName: "email", operator: "EQ", value: email }],
          },
        ],
        properties: ["email", "firstname", "lastname", "lifecyclestage"],
        limit: 1,
      })
    );

    const result = searchResult.data.results?.[0];
    if (!result) return null;

    const contact: ContactRecord = {
      id: result.id,
      email: result.properties?.email,
      firstName: result.properties?.firstname,
      lastName: result.properties?.lastname,
      lifecycleStage: result.properties?.lifecyclestage,
    };

    const companyName = await this.getPrimaryCompanyName(result.id);
    if (companyName) contact.companyName = companyName;

    return contact;
  }

  private async getPrimaryCompanyName(contactId: string): Promise<string | undefined> {
    const assocResult = await this.request(() =>
      this.http.get(`/crm/v3/objects/contacts/${contactId}/associations/companies`)
    );
    const companyId = assocResult.data.results?.[0]?.id;
    if (!companyId) return undefined;

    const companyResult = await this.request(() =>
      this.http.get(`/crm/v3/objects/companies/${companyId}`, {
        params: { properties: "name" },
      })
    );
    return companyResult.data.properties?.name;
  }

  /** Full-text search companies by name/domain, returning basic identifying info. */
  async searchCompanies(query: string, limit = 10): Promise<CompanyRecord[]> {
    const result = await this.request(() =>
      this.http.post("/crm/v3/objects/companies/search", {
        query,
        properties: ["name", "domain"],
        limit,
      })
    );

    return (result.data.results ?? []).map((r: any) => ({
      id: r.id,
      name: r.properties?.name,
      domain: r.properties?.domain,
    }));
  }

  /** Create or update (upsert by email) a contact. */
  async createOrUpdateContact(input: {
    email: string;
    firstName?: string;
    lastName?: string;
    company?: string;
  }): Promise<ContactRecord> {
    const properties: Record<string, string> = { email: input.email };
    if (input.firstName) properties.firstname = input.firstName;
    if (input.lastName) properties.lastname = input.lastName;
    if (input.company) properties.company = input.company;

    try {
      const created = await this.request(() =>
        this.http.post("/crm/v3/objects/contacts", { properties })
      );
      return {
        id: created.data.id,
        email: created.data.properties?.email,
        firstName: created.data.properties?.firstname,
        lastName: created.data.properties?.lastname,
      };
    } catch (err) {
      if (err instanceof HubSpotApiError && err.status === 409) {
        return this.updateContactByEmail(input.email, properties);
      }
      throw err;
    }
  }

  private async updateContactByEmail(
    email: string,
    properties: Record<string, string>
  ): Promise<ContactRecord> {
    const updated = await this.request(() =>
      this.http.patch(`/crm/v3/objects/contacts/${encodeURIComponent(email)}`, { properties }, {
        params: { idProperty: "email" },
      })
    );
    return {
      id: updated.data.id,
      email: updated.data.properties?.email,
      firstName: updated.data.properties?.firstname,
      lastName: updated.data.properties?.lastname,
    };
  }

  /** Log an engagement (note/email/call) on a contact's timeline. */
  async logActivity(input: {
    contactId: string;
    activityType: ActivityType;
    body: string;
  }): Promise<{ engagementId: string }> {
    const engagementTypeMap: Record<ActivityType, string> = {
      NOTE: "notes",
      EMAIL: "emails",
      CALL: "calls",
    };

    const objectType = engagementTypeMap[input.activityType];
    const properties = this.buildEngagementProperties(input.activityType, input.body);

    const created = await this.request(() =>
      this.http.post(`/crm/v3/objects/${objectType}`, {
        properties,
        associations: [
          {
            to: { id: input.contactId },
            types: [
              {
                associationCategory: "HUBSPOT_DEFINED",
                associationTypeId: this.engagementAssociationTypeId(input.activityType),
              },
            ],
          },
        ],
      })
    );

    return { engagementId: created.data.id };
  }

  private buildEngagementProperties(
    activityType: ActivityType,
    body: string
  ): Record<string, string> {
    const timestamp = new Date().toISOString();
    switch (activityType) {
      case "NOTE":
        return { hs_note_body: body, hs_timestamp: timestamp };
      case "EMAIL":
        return { hs_email_direction: "EMAIL", hs_email_status: "SENT", hs_body_preview: body, hs_timestamp: timestamp };
      case "CALL":
        return { hs_call_body: body, hs_call_direction: "OUTBOUND", hs_timestamp: timestamp };
    }
  }

  private engagementAssociationTypeId(activityType: ActivityType): number {
    // HubSpot-defined default association type IDs for engagement -> contact.
    switch (activityType) {
      case "NOTE":
        return 202;
      case "EMAIL":
        return 198;
      case "CALL":
        return 194;
    }
  }
}
