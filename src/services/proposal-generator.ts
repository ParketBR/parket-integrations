import { google } from "googleapis";
import Handlebars from "handlebars";
import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { addDealNote } from "../connectors/pipedrive/client.js";
import type { Lead, NewProposal } from "../db/schemas/types.js";

const log = createChildLogger("service:proposal-generator");

// ─── Types ─────────────────────────────────────────

export interface ProposalItem {
  description: string;
  product: string;
  area_m2: number;
  unit_price: number;
  total: number;
}

export interface ProposalInput {
  lead_id: string;
  project_name: string;
  items: ProposalItem[];
  payment_terms?: string;
  validity_days?: number;
  notes?: string;
}

// ─── Proposal Template (HTML for Google Docs) ──────

const PROPOSAL_TEMPLATE = `
<h1>Proposta Comercial — Parket</h1>
<h2>{{project_name}}</h2>

<p><strong>Cliente:</strong> {{client_name}}</p>
<p><strong>Data:</strong> {{date}}</p>
<p><strong>Validade:</strong> {{validity_days}} dias</p>
{{#if location}}<p><strong>Local:</strong> {{location}}</p>{{/if}}

<hr/>

<h3>1. Diagnostico</h3>
<p>Entendemos que seu projeto {{project_name}} necessita de pisos de madeira de alto padrao
que combinem durabilidade, estetica e valorizacao do ambiente.</p>

<h3>2. Escopo Tecnico</h3>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
  <tr style="background: #2c2c2c; color: white;">
    <th>Produto</th>
    <th>Descricao</th>
    <th>Area (m²)</th>
    <th>Valor Unitario</th>
    <th>Subtotal</th>
  </tr>
  {{#each items}}
  <tr>
    <td>{{this.product}}</td>
    <td>{{this.description}}</td>
    <td>{{this.area_m2}}</td>
    <td>R$ {{formatCurrency this.unit_price}}</td>
    <td>R$ {{formatCurrency this.total}}</td>
  </tr>
  {{/each}}
  <tr style="font-weight: bold; background: #f5f5f5;">
    <td colspan="4" align="right">TOTAL</td>
    <td>R$ {{formatCurrency total_value}}</td>
  </tr>
</table>

<h3>3. Diferenciais Parket</h3>
<ul>
  <li><strong>Garantia estendida</strong> — protecao total do seu investimento</li>
  <li><strong>Mao de obra propria</strong> — instalacao com equipe treinada Parket</li>
  <li><strong>Acabamento impecavel</strong> — controle de qualidade em cada etapa</li>
  <li><strong>Suporte tecnico</strong> — acompanhamento pre, durante e pos-obra</li>
</ul>

<h3>4. Investimento e Condicoes</h3>
<p><strong>Valor total:</strong> R$ {{formatCurrency total_value}}</p>
{{#if payment_terms}}<p><strong>Condicoes:</strong> {{payment_terms}}</p>{{/if}}

<h3>5. Proximos Passos</h3>
<ol>
  <li>Aprovacao desta proposta</li>
  <li>Assinatura do contrato</li>
  <li>Vistoria tecnica pre-obra</li>
  <li>Programacao de entrega e instalacao</li>
</ol>

{{#if notes}}<h3>Observacoes</h3><p>{{notes}}</p>{{/if}}

<hr/>
<p style="font-size: 0.9em; color: #666;">
  Proposta valida por {{validity_days}} dias. Valores sujeitos a confirmacao de estoque.
  Parket — Pisos de Madeira de Alto Padrao.
</p>
`;

// Register Handlebars helpers
Handlebars.registerHelper("formatCurrency", (value: number) => {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
});

/**
 * Generate a proposal from lead + items data.
 * Creates record in DB. Optionally creates Google Doc.
 */
export async function generateProposal(
  input: ProposalInput
): Promise<string> {
  const lead = await db
    .selectFrom("leads")
    .selectAll()
    .where("id", "=", input.lead_id)
    .executeTakeFirstOrThrow();

  const totalValue = input.items.reduce((sum, i) => sum + i.total, 0);
  const validityDays = input.validity_days ?? 15;

  // Check existing proposals to set version
  const existingCount = await db
    .selectFrom("proposals")
    .select(db.fn.count("id").as("count"))
    .where("lead_id", "=", input.lead_id)
    .executeTakeFirstOrThrow();

  const version = Number(existingCount.count) + 1;

  // Insert proposal
  const [proposal] = await db
    .insertInto("proposals")
    .values({
      lead_id: input.lead_id,
      pipedrive_deal_id: lead.pipedrive_deal_id,
      version,
      status: "draft",
      client_name: lead.name,
      project_name: input.project_name,
      project_type: lead.project_type,
      location: lead.location,
      items: input.items as unknown as Record<string, unknown>[],
      total_value: totalValue,
      payment_terms: input.payment_terms ?? null,
      validity_days: validityDays,
      google_doc_id: null,
      pdf_url: null,
      sent_at: null,
      viewed_at: null,
      responded_at: null,
      expires_at: new Date(Date.now() + validityDays * 86_400_000),
    })
    .returningAll()
    .execute();

  // Log activity
  await db
    .insertInto("activities")
    .values({
      lead_id: input.lead_id,
      type: "proposal_sent",
      description: `Proposta v${version} gerada: R$ ${totalValue.toLocaleString("pt-BR")}`,
      metadata: {
        proposal_id: proposal.id,
        version,
        total_value: totalValue,
        items_count: input.items.length,
      },
    })
    .execute();

  // Try to create Google Doc
  try {
    const docId = await createGoogleDoc(lead, proposal.id, input, totalValue, validityDays);
    if (docId) {
      await db
        .updateTable("proposals")
        .set({ google_doc_id: docId })
        .where("id", "=", proposal.id)
        .execute();
    }
  } catch (err) {
    log.warn({ err }, "Google Docs creation failed, proposal saved without doc");
  }

  // Add note to Pipedrive deal
  if (lead.pipedrive_deal_id) {
    try {
      await addDealNote(
        lead.pipedrive_deal_id,
        `Proposta v${version} gerada — R$ ${totalValue.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}\nItens: ${input.items.length}\nValidade: ${validityDays} dias`
      );
    } catch (err) {
      log.warn({ err }, "Failed to add Pipedrive note");
    }
  }

  log.info(
    { proposalId: proposal.id, leadId: lead.id, totalValue, version },
    "Proposal generated"
  );

  return proposal.id;
}

/**
 * Render proposal to HTML string
 */
export function renderProposalHtml(
  lead: Lead,
  input: ProposalInput,
  totalValue: number,
  validityDays: number
): string {
  const compiled = Handlebars.compile(PROPOSAL_TEMPLATE);
  return compiled({
    client_name: lead.name,
    project_name: input.project_name,
    date: new Date().toLocaleDateString("pt-BR"),
    location: lead.location,
    items: input.items,
    total_value: totalValue,
    payment_terms: input.payment_terms,
    validity_days: validityDays,
    notes: input.notes,
  });
}

/**
 * Create a Google Doc with the proposal content.
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY env var with service account JSON.
 */
async function createGoogleDoc(
  lead: Lead,
  proposalId: string,
  input: ProposalInput,
  totalValue: number,
  validityDays: number
): Promise<string | null> {
  const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!serviceAccountKey) {
    log.debug("GOOGLE_SERVICE_ACCOUNT_KEY not set, skipping Google Docs creation");
    return null;
  }

  const credentials = JSON.parse(serviceAccountKey);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive",
    ],
  });

  const docs = google.docs({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });

  // Create document
  const doc = await docs.documents.create({
    requestBody: {
      title: `Proposta Parket — ${lead.name} — ${input.project_name}`,
    },
  });

  const docId = doc.data.documentId!;

  // Insert rendered HTML as plain text (Google Docs API limitation)
  const html = renderProposalHtml(lead, input, totalValue, validityDays);
  const plainText = html
    .replace(/<[^>]+>/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: 1 },
            text: plainText,
          },
        },
      ],
    },
  });

  // Share with anyone who has link (for easy access)
  const folderId = process.env.GOOGLE_PROPOSALS_FOLDER_ID;
  if (folderId) {
    await drive.files.update({
      fileId: docId,
      addParents: folderId,
      requestBody: {},
    });
  }

  log.info({ docId, proposalId }, "Google Doc created");
  return docId;
}

/**
 * Mark a proposal as sent and update timestamps
 */
export async function markProposalSent(proposalId: string): Promise<void> {
  const now = new Date();
  await db
    .updateTable("proposals")
    .set({ status: "sent", sent_at: now })
    .where("id", "=", proposalId)
    .execute();

  const proposal = await db
    .selectFrom("proposals")
    .select(["lead_id"])
    .where("id", "=", proposalId)
    .executeTakeFirstOrThrow();

  // Start proposal SLA (72h to respond is already tracked, but start "viewed" tracking)
  log.info({ proposalId }, "Proposal marked as sent");
}

/**
 * Update proposal status (viewed, accepted, rejected)
 */
export async function updateProposalStatus(
  proposalId: string,
  status: "viewed" | "accepted" | "rejected"
): Promise<void> {
  const now = new Date();
  const updates: Record<string, unknown> = { status };

  if (status === "viewed") updates.viewed_at = now;
  if (status === "accepted" || status === "rejected") updates.responded_at = now;

  await db
    .updateTable("proposals")
    .set(updates)
    .where("id", "=", proposalId)
    .execute();

  log.info({ proposalId, status }, "Proposal status updated");
}
