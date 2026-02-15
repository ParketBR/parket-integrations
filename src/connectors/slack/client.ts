import axios from "axios";
import axiosRetry from "axios-retry";
import { createChildLogger } from "../../config/logger.js";

const log = createChildLogger("connector:slack");

const client = axios.create({ timeout: 10_000 });

axiosRetry(client, {
  retries: 2,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (err) =>
    axiosRetry.isNetworkOrIdempotentRequestError(err) ||
    err.response?.status === 429,
});

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: Array<{ type: string; text: string }>;
  [key: string]: unknown;
}

interface SlackMessage {
  text: string;
  blocks?: SlackBlock[];
  channel?: string;
}

/**
 * Send a message to Slack via incoming webhook
 */
export async function sendSlackMessage(message: SlackMessage): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    log.debug("SLACK_WEBHOOK_URL not configured, skipping Slack notification");
    return;
  }

  log.info("Sending Slack notification");

  await client.post(webhookUrl, {
    text: message.text,
    blocks: message.blocks,
    ...(message.channel ? { channel: message.channel } : {}),
  });
}

/**
 * Send an alert with severity level
 */
export async function sendSlackAlert(
  severity: "info" | "warning" | "critical",
  title: string,
  details: string
): Promise<void> {
  const emoji: Record<string, string> = {
    info: "ℹ️",
    warning: "⚠️",
    critical: "🚨",
  };

  const color: Record<string, string> = {
    info: "#36a64f",
    warning: "#daa520",
    critical: "#dc3545",
  };

  await sendSlackMessage({
    text: `${emoji[severity]} ${title}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${emoji[severity]} ${title}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: details },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*Severity:* ${severity} | *Time:* ${new Date().toLocaleString("pt-BR")}`,
          },
        ],
      },
    ],
  });
}
