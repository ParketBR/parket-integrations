import axios from "axios";
import axiosRetry from "axios-retry";
import { createChildLogger } from "../../config/logger.js";

const log = createChildLogger("connector:whatsapp");

let waClient: ReturnType<typeof axios.create> | null = null;

function getClient() {
  if (!waClient) {
    waClient = axios.create({
      baseURL: process.env.WHATSAPP_API_URL,
      timeout: 15_000,
      headers: {
        apikey: process.env.WHATSAPP_API_KEY ?? "",
        "Content-Type": "application/json",
      },
    });

    axiosRetry(waClient, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        err.response?.status === 429,
      onRetry: (count, err) => {
        log.warn({ attempt: count, err: err.message }, "Retrying WhatsApp API");
      },
    });
  }
  return waClient;
}

const instance = () => process.env.WHATSAPP_INSTANCE ?? "parket-main";

/**
 * Send a text message via Evolution API
 */
export async function sendTextMessage(
  phone: string,
  text: string
): Promise<void> {
  const number = normalizePhone(phone);
  log.info({ phone: number }, "Sending WhatsApp text message");

  await getClient().post(`/message/sendText/${instance()}`, {
    number,
    text,
  });
}

/**
 * Send message to a group
 */
export async function sendGroupMessage(
  groupId: string,
  text: string
): Promise<void> {
  log.info({ groupId }, "Sending WhatsApp group message");

  await getClient().post(`/message/sendText/${instance()}`, {
    number: groupId,
    text,
  });
}

/**
 * Notify SDR group about a new lead
 */
export async function notifyNewLead(lead: {
  name: string;
  phone: string;
  source: string;
  project_type?: string | null;
  location?: string | null;
}): Promise<void> {
  const groupId = process.env.WHATSAPP_SDR_GROUP;
  if (!groupId) {
    log.warn("WHATSAPP_SDR_GROUP not configured, skipping notification");
    return;
  }

  const msg = [
    `*Novo Lead Parket*`,
    ``,
    `Nome: ${lead.name}`,
    `Telefone: ${lead.phone}`,
    `Origem: ${lead.source}`,
    lead.project_type ? `Tipo: ${lead.project_type}` : null,
    lead.location ? `Local: ${lead.location}` : null,
    ``,
    `SLA: Responder em 5 min`,
  ]
    .filter(Boolean)
    .join("\n");

  await sendGroupMessage(groupId, msg);
}

/**
 * Normalize Brazilian phone number to WhatsApp format
 */
export function normalizePhone(phone: string): string {
  // Remove everything except digits
  let digits = phone.replace(/\D/g, "");

  // Add country code if missing
  if (digits.length === 10 || digits.length === 11) {
    digits = "55" + digits;
  }

  // Add 9th digit for mobile if missing (Brazilian numbers)
  if (digits.length === 12 && digits.startsWith("55")) {
    const ddd = digits.substring(2, 4);
    const number = digits.substring(4);
    if (number.length === 8 && !number.startsWith("0")) {
      digits = `55${ddd}9${number}`;
    }
  }

  return digits;
}
