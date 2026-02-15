import { db } from "../db/connection.js";
import { createChildLogger } from "../config/logger.js";
import { sendTextMessage } from "../connectors/whatsapp/client.js";

const log = createChildLogger("service:project-communications");

// ─── Message Templates ─────────────────────────────

const TEMPLATES: Record<string, (ctx: TemplateContext) => string> = {
  handoff_confirmation: (ctx) =>
    [
      `Ola ${ctx.clientName}! Aqui e a Parket.`,
      ``,
      `Seu contrato foi confirmado e estamos muito felizes em ter voce como cliente!`,
      ``,
      `Proximos passos:`,
      `1. Nossa equipe tecnica vai entrar em contato para agendar a vistoria`,
      `2. Confirmaremos as medidas finais e condicoes da base`,
      `3. Faremos o pedido do material`,
      `4. Agendaremos a instalacao`,
      ``,
      `Qualquer duvida, estamos a disposicao!`,
      `Equipe Parket`,
    ].join("\n"),

  status_vistoria: (ctx) =>
    [
      `${ctx.clientName}, boas noticias!`,
      ``,
      `A vistoria tecnica do seu projeto${ctx.location ? ` em ${ctx.location}` : ""} foi concluida com sucesso.`,
      `Estamos providenciando o material para sua obra.`,
      ``,
      `Em breve entraremos em contato para agendar a instalacao.`,
    ].join("\n"),

  status_material_pedido: (ctx) =>
    `${ctx.clientName}, informamos que o material do seu projeto ja foi solicitado ao fornecedor. Assim que confirmarmos a data de entrega, avisaremos sobre o agendamento da instalacao.`,

  status_agendado: (ctx) =>
    [
      `${ctx.clientName}, otima noticia!`,
      ``,
      `Sua instalacao foi agendada${ctx.installationDate ? ` para ${ctx.installationDate}` : ""}.`,
      ``,
      `Lembretes importantes:`,
      `- O ambiente deve estar limpo e desocupado`,
      `- Evitar transito de pessoas durante a instalacao`,
      `- Mantenha ventilacao adequada`,
      ``,
      `Contaremos com o acesso${ctx.accessHours ? ` no horario: ${ctx.accessHours}` : ""}.`,
    ].join("\n"),

  status_em_execucao: (ctx) =>
    `${ctx.clientName}, a instalacao do seu piso Parket comecou! Nossa equipe esta no local trabalhando com todo cuidado. Em caso de qualquer duvida, entre em contato.`,

  status_entrega: (ctx) =>
    [
      `${ctx.clientName}, sua instalacao foi concluida!`,
      ``,
      `Faremos uma inspecao final e limpeza para garantir a perfeicao do resultado.`,
      `Entraremos em contato para agendar a entrega oficial e assinatura do termo.`,
    ].join("\n"),

  status_concluido: (ctx) =>
    [
      `${ctx.clientName}, parabens!`,
      ``,
      `Seu projeto Parket esta oficialmente concluido!`,
      ``,
      `Agradecemos a confianca. Lembre-se:`,
      `- Siga o manual de manutencao para preservar seu piso`,
      `- Nossa garantia cobre eventuais necessidades`,
      `- Estamos sempre a disposicao`,
      ``,
      `Se ficou satisfeito, considere nos recomendar para amigos e arquitetos.`,
      `Obrigado! Equipe Parket`,
    ].join("\n"),

  delay_notification: (ctx) =>
    `${ctx.clientName}, informamos que houve um ajuste no cronograma do seu projeto${ctx.location ? ` em ${ctx.location}` : ""}. Estamos trabalhando para minimizar o impacto e entraremos em contato com a nova data prevista. Pedimos desculpas pelo inconveniente.`,

  architect_update: (ctx) =>
    `Prezado(a) ${ctx.architectName ?? "Arquiteto(a)"}, informamos que o projeto ${ctx.projectName}${ctx.clientName ? ` (cliente ${ctx.clientName})` : ""} esta no status: ${ctx.statusLabel}. Em caso de duvidas tecnicas, estamos a disposicao.`,
};

interface TemplateContext {
  clientName: string;
  architectName?: string | null;
  projectName: string;
  location?: string | null;
  statusLabel?: string;
  installationDate?: string | null;
  accessHours?: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  handoff: "Contrato assinado",
  vistoria: "Vistoria concluida",
  material_pedido: "Material solicitado",
  aguardando_material: "Aguardando material",
  agendado: "Instalacao agendada",
  em_execucao: "Em execucao",
  entrega: "Instalacao concluida",
  pos_obra: "Em pos-obra",
  concluido: "Projeto concluido",
};

/**
 * Send a project update to client (and optionally architect)
 */
export async function sendProjectUpdate(
  projectId: string,
  templateKey: string
): Promise<void> {
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();

  const templateFn = TEMPLATES[templateKey];
  if (!templateFn) {
    log.warn({ templateKey }, "Unknown template key");
    return;
  }

  const context: TemplateContext = {
    clientName: project.client_name,
    architectName: project.architect_name,
    projectName: project.name,
    location: project.location,
    statusLabel: STATUS_LABELS[project.status] ?? project.status,
    installationDate: project.installation_start_at
      ? new Date(project.installation_start_at).toLocaleDateString("pt-BR")
      : null,
    accessHours: project.access_hours,
  };

  const message = templateFn(context);

  // Send to client
  try {
    await sendTextMessage(project.client_phone, message);
    await logCommunication(projectId, "client", project.client_phone, "whatsapp", message, templateKey);
    log.info({ projectId, templateKey, recipient: "client" }, "Project update sent");
  } catch (err) {
    log.error({ err, projectId }, "Failed to send client update");
  }

  // Send to architect if exists and template supports it
  if (project.architect_phone && templateKey.startsWith("status_")) {
    try {
      const archTemplateFn = TEMPLATES.architect_update;
      const archMessage = archTemplateFn(context);
      await sendTextMessage(project.architect_phone, archMessage);
      await logCommunication(projectId, "architect", project.architect_phone, "whatsapp", archMessage, "architect_update");
    } catch (err) {
      log.error({ err, projectId }, "Failed to send architect update");
    }
  }
}

async function logCommunication(
  projectId: string,
  recipientType: string,
  recipientPhone: string,
  channel: string,
  message: string,
  templateKey: string
): Promise<void> {
  await db
    .insertInto("project_communications")
    .values({
      project_id: projectId,
      recipient_type: recipientType as "client" | "architect" | "site_contact" | "internal",
      recipient_phone: recipientPhone,
      channel: channel as "whatsapp" | "email" | "call",
      message: message.substring(0, 2000),
      template_key: templateKey,
    })
    .execute();
}
