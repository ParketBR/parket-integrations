import axios from "axios";
import axiosRetry from "axios-retry";
import { createChildLogger } from "../../config/logger.js";

const log = createChildLogger("connector:pipedrive");

let pdClient: ReturnType<typeof axios.create> | null = null;

function getClient() {
  if (!pdClient) {
    const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
    const token = process.env.PIPEDRIVE_API_TOKEN;

    pdClient = axios.create({
      baseURL: `https://${domain}/api/v1`,
      timeout: 15_000,
      params: { api_token: token },
    });

    axiosRetry(pdClient, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        err.response?.status === 429,
      onRetry: (count, err) => {
        log.warn({ attempt: count, err: err.message }, "Retrying Pipedrive API");
      },
    });
  }
  return pdClient;
}

// ─── Types ─────────────────────────────────────────

export interface PipedrivePerson {
  id: number;
  name: string;
  email: Array<{ value: string; primary: boolean }>;
  phone: Array<{ value: string; primary: boolean }>;
}

export interface PipedriveDeal {
  id: number;
  title: string;
  value: number;
  currency: string;
  stage_id: number;
  person_id: number;
  status: string;
}

// ─── Persons ───────────────────────────────────────

export async function findPersonByPhone(
  phone: string
): Promise<PipedrivePerson | null> {
  log.debug({ phone }, "Searching person by phone");

  const { data } = await getClient().get("/persons/search", {
    params: { term: phone, fields: "phone", limit: 1 },
  });

  const items = data?.data?.items;
  if (!items?.length) return null;

  return items[0].item as PipedrivePerson;
}

export async function createPerson(person: {
  name: string;
  email?: string;
  phone: string;
}): Promise<PipedrivePerson> {
  log.info({ name: person.name }, "Creating Pipedrive person");

  const { data } = await getClient().post("/persons", {
    name: person.name,
    email: person.email ? [{ value: person.email, primary: true }] : undefined,
    phone: [{ value: person.phone, primary: true }],
  });

  return data.data as PipedrivePerson;
}

// ─── Deals ─────────────────────────────────────────

export async function createDeal(deal: {
  title: string;
  person_id: number;
  value?: number;
  stage_id?: number;
  pipeline_id?: number;
}): Promise<PipedriveDeal> {
  log.info({ title: deal.title, person_id: deal.person_id }, "Creating deal");

  const { data } = await getClient().post("/deals", deal);
  return data.data as PipedriveDeal;
}

export async function updateDealStage(
  dealId: number,
  stageId: number
): Promise<void> {
  log.info({ dealId, stageId }, "Updating deal stage");

  await getClient().put(`/deals/${dealId}`, { stage_id: stageId });
}

export async function addDealNote(
  dealId: number,
  content: string
): Promise<void> {
  await getClient().post("/notes", {
    deal_id: dealId,
    content,
  });
}

// ─── Activities ────────────────────────────────────

export async function createActivity(activity: {
  deal_id: number;
  subject: string;
  type: string;
  note?: string;
  due_date?: string;
  due_time?: string;
}): Promise<void> {
  log.info({ deal_id: activity.deal_id, subject: activity.subject }, "Creating activity");

  await getClient().post("/activities", activity);
}
