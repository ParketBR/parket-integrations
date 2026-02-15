import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { overwriteSheet } from "../connectors/sheets/client.js";

const log = createChildLogger("service:sheets-export");

/**
 * Export current pipeline to a Google Sheet.
 * Overwrites the "Pipeline" tab with fresh data.
 */
export async function exportPipelineToSheets(): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_PIPELINE_SHEET_ID;
  if (!spreadsheetId) {
    log.debug("GOOGLE_PIPELINE_SHEET_ID not set, skipping export");
    return;
  }

  const leads = await db
    .selectFrom("leads")
    .select([
      "name",
      "phone",
      "email",
      "source",
      "funnel",
      "stage",
      "client_type",
      "project_type",
      "location",
      "estimated_ticket",
      "score",
      "created_at",
      "updated_at",
    ])
    .where("stage", "not in", ["perdido"])
    .orderBy("created_at", "desc")
    .execute();

  const headers = [
    "Nome",
    "Telefone",
    "Email",
    "Origem",
    "Funil",
    "Etapa",
    "Tipo Cliente",
    "Tipo Projeto",
    "Local",
    "Ticket Estimado",
    "Score",
    "Criado em",
    "Atualizado em",
  ];

  const rows = leads.map((l) => [
    l.name,
    l.phone,
    l.email ?? "",
    l.source,
    l.funnel,
    l.stage,
    l.client_type ?? "",
    l.project_type ?? "",
    l.location ?? "",
    l.estimated_ticket ? Number(l.estimated_ticket) : null,
    l.score,
    new Date(l.created_at).toLocaleDateString("pt-BR"),
    new Date(l.updated_at).toLocaleDateString("pt-BR"),
  ]);

  await overwriteSheet(spreadsheetId, "Pipeline", headers, rows);
  log.info({ rowCount: rows.length }, "Pipeline exported to Sheets");
}

/**
 * Export proposals to a Google Sheet.
 */
export async function exportProposalsToSheets(): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_PIPELINE_SHEET_ID;
  if (!spreadsheetId) return;

  const proposals = await db
    .selectFrom("proposals")
    .innerJoin("leads", "leads.id", "proposals.lead_id")
    .select([
      "proposals.id",
      "proposals.client_name",
      "proposals.project_name",
      "proposals.total_value",
      "proposals.status",
      "proposals.version",
      "proposals.created_at",
      "proposals.sent_at",
      "proposals.responded_at",
      "leads.funnel",
      "leads.source",
    ])
    .orderBy("proposals.created_at", "desc")
    .execute();

  const headers = [
    "ID",
    "Cliente",
    "Projeto",
    "Valor",
    "Status",
    "Versao",
    "Funil",
    "Origem",
    "Criada",
    "Enviada",
    "Respondida",
  ];

  const rows = proposals.map((p) => [
    p.id,
    p.client_name,
    p.project_name,
    Number(p.total_value),
    p.status,
    p.version,
    p.funnel,
    p.source,
    new Date(p.created_at).toLocaleDateString("pt-BR"),
    p.sent_at ? new Date(p.sent_at).toLocaleDateString("pt-BR") : "",
    p.responded_at ? new Date(p.responded_at).toLocaleDateString("pt-BR") : "",
  ]);

  await overwriteSheet(spreadsheetId, "Propostas", headers, rows);
  log.info({ rowCount: rows.length }, "Proposals exported to Sheets");
}
