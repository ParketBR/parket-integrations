import axios from "axios";
import axiosRetry from "axios-retry";
import crypto from "crypto";
import { createChildLogger } from "../../config/logger.js";

const log = createChildLogger("connector:meta");

const META_GRAPH_URL = "https://graph.facebook.com/v19.0";

const client = axios.create({
  baseURL: META_GRAPH_URL,
  timeout: 10_000,
});

axiosRetry(client, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (err) =>
    axiosRetry.isNetworkOrIdempotentRequestError(err) ||
    err.response?.status === 429,
  onRetry: (count, err) => {
    log.warn({ attempt: count, err: err.message }, "Retrying Meta API call");
  },
});

export interface MetaLeadData {
  id: string;
  created_time: string;
  field_data: Array<{ name: string; values: string[] }>;
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  form_id?: string;
}

/**
 * Fetch full lead data from Meta Graph API
 */
export async function fetchLeadData(
  leadgenId: string,
  accessToken: string
): Promise<MetaLeadData> {
  log.info({ leadgenId }, "Fetching lead data from Meta");

  const { data } = await client.get<MetaLeadData>(`/${leadgenId}`, {
    params: { access_token: accessToken },
  });

  return data;
}

/**
 * Verify Meta webhook signature (X-Hub-Signature-256)
 */
export function verifyMetaSignature(
  payload: string | Buffer,
  signature: string,
  appSecret: string
): boolean {
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(payload).digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature)
  );
}

/**
 * Extract field values from Meta lead form data
 */
export function extractLeadFields(
  fieldData: MetaLeadData["field_data"]
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const field of fieldData) {
    fields[field.name.toLowerCase()] = field.values[0] ?? "";
  }
  return fields;
}
