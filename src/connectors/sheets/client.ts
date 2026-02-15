import { google } from "googleapis";
import { createChildLogger } from "../../config/logger.js";

const log = createChildLogger("connector:sheets");

function getAuth() {
  const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!serviceAccountKey) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
  }

  const credentials = JSON.parse(serviceAccountKey);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

/**
 * Append rows to a Google Sheet
 */
export async function appendRows(
  spreadsheetId: string,
  sheetName: string,
  rows: (string | number | null)[][]
): Promise<void> {
  const sheets = google.sheets({ version: "v4", auth: getAuth() });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });

  log.info(
    { spreadsheetId, sheetName, rowCount: rows.length },
    "Rows appended to sheet"
  );
}

/**
 * Update a specific range in a Google Sheet
 */
export async function updateRange(
  spreadsheetId: string,
  range: string,
  values: (string | number | null)[][]
): Promise<void> {
  const sheets = google.sheets({ version: "v4", auth: getAuth() });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  log.info({ spreadsheetId, range }, "Sheet range updated");
}

/**
 * Read values from a Google Sheet range
 */
export async function readRange(
  spreadsheetId: string,
  range: string
): Promise<(string | number)[][]> {
  const sheets = google.sheets({ version: "v4", auth: getAuth() });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  return (response.data.values as (string | number)[][]) ?? [];
}

/**
 * Clear a sheet and write fresh data (full overwrite)
 */
export async function overwriteSheet(
  spreadsheetId: string,
  sheetName: string,
  headers: string[],
  rows: (string | number | null)[][]
): Promise<void> {
  const sheets = google.sheets({ version: "v4", auth: getAuth() });

  // Clear existing data
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetName}!A:ZZ`,
  });

  // Write headers + data
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [headers, ...rows],
    },
  });

  log.info(
    { spreadsheetId, sheetName, rowCount: rows.length },
    "Sheet overwritten"
  );
}
