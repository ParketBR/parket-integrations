/**
 * Structured logging for Cloud Run.
 * Outputs JSON that Cloud Logging picks up natively.
 * Uses severity levels compatible with Google Cloud.
 */

type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

interface LogEntry {
  severity: Severity;
  message: string;
  module?: string;
  correlation_id?: string;
  [key: string]: unknown;
}

function emit(entry: LogEntry): void {
  const output = {
    ...entry,
    timestamp: new Date().toISOString(),
    "logging.googleapis.com/labels": {
      service: "parket-control-tower",
      module: entry.module ?? "unknown",
    },
  };
  // Cloud Logging reads from stdout/stderr
  if (entry.severity === "ERROR" || entry.severity === "CRITICAL") {
    process.stderr.write(JSON.stringify(output) + "\n");
  } else {
    process.stdout.write(JSON.stringify(output) + "\n");
  }
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) =>
      emit({ severity: "DEBUG", message: msg, module, ...extra }),
    info: (msg: string, extra?: Record<string, unknown>) =>
      emit({ severity: "INFO", message: msg, module, ...extra }),
    warn: (msg: string, extra?: Record<string, unknown>) =>
      emit({ severity: "WARNING", message: msg, module, ...extra }),
    error: (msg: string, extra?: Record<string, unknown>) =>
      emit({ severity: "ERROR", message: msg, module, ...extra }),
    critical: (msg: string, extra?: Record<string, unknown>) =>
      emit({ severity: "CRITICAL", message: msg, module, ...extra }),
  };
}
