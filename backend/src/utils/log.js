// Structured logging: one JSON object per line on stdout, so CloudWatch Logs
// Insights can filter and aggregate on fields (level, event, userId, jobId...).
//
//   log.info("job submitted", { event: "job.submitted", jobId, userId });
//
// Conventions:
// - `msg` is a short human sentence; `event` (dotted, stable) is what alarms
//   and saved queries match on, so do not rename events casually.
// - Never log secrets, passwords, tokens, cookies, request bodies or query
//   strings (the GitHub callback carries an OAuth code in its query).
// - Errors: pass { err } and it is expanded to { error, stack }.
//
// Format: JSON in production (or TALON_LOG_FORMAT=json); a readable one-line
// format otherwise. Level: TALON_LOG_LEVEL (debug, info, warn, error; default
// info). TALON_LOG_LEVEL=silent turns logging off.

const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function configuredLevel() {
  const name = String(process.env.TALON_LOG_LEVEL || "info").toLowerCase();
  return levels[name] ?? levels.info;
}

function jsonFormat() {
  const format = String(process.env.TALON_LOG_FORMAT || "").toLowerCase();
  if (format) {
    return format === "json";
  }
  return process.env.NODE_ENV === "production";
}

function expandError(fields) {
  if (!fields?.err) {
    return fields;
  }
  const { err, ...rest } = fields;
  return {
    ...rest,
    error: err?.message || String(err),
    ...(err?.stack ? { stack: err.stack } : {}),
  };
}

function write(level, msg, fields, sink) {
  if (levels[level] < configuredLevel()) {
    return;
  }
  const extra = expandError(fields) || {};
  if (jsonFormat()) {
    let line;
    try {
      line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra });
    } catch {
      line = JSON.stringify({ time: new Date().toISOString(), level, msg, note: "fields not serializable" });
    }
    sink.write(`${line}\n`);
    return;
  }
  const { stack, ...shown } = extra;
  const pairs = Object.entries(shown)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  sink.write(`${level.toUpperCase().padEnd(5)} ${msg}${pairs ? ` ${pairs}` : ""}\n${stack ? `${stack}\n` : ""}`);
}

export const log = {
  debug: (msg, fields) => write("debug", msg, fields, process.stdout),
  info: (msg, fields) => write("info", msg, fields, process.stdout),
  warn: (msg, fields) => write("warn", msg, fields, process.stdout),
  // Same stream as the rest: on the server stdout and stderr go to one file,
  // and a single stream keeps lines in order.
  error: (msg, fields) => write("error", msg, fields, process.stdout),
};

export default log;
