import crypto from "crypto";
import { createChildLogger } from "../../config/logger.js";

const log = createChildLogger("connector:google");

export interface GoogleLeadPayload {
  google_key: string;
  lead_id: string;
  gcl_id?: string;
  campaign_id?: string;
  adgroup_id?: string;
  creative_id?: string;
  column_data: Array<{
    column_id: string;
    string_value?: string;
    column_name?: string;
  }>;
}

/**
 * Verify Google Ads webhook secret via header token
 */
export function verifyGoogleWebhook(
  token: string,
  expectedSecret: string
): boolean {
  if (!token || !expectedSecret) return false;
  return crypto.timingSafeEqual(
    Buffer.from(token),
    Buffer.from(expectedSecret)
  );
}

/**
 * Extract fields from Google Lead Form extension data
 */
export function extractGoogleLeadFields(
  columnData: GoogleLeadPayload["column_data"]
): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const col of columnData) {
    const key = (col.column_name ?? col.column_id).toLowerCase().replace(/\s+/g, "_");
    fields[key] = col.string_value ?? "";
  }

  log.debug({ fields }, "Extracted Google lead fields");
  return fields;
}
