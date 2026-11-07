import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { log } from "../utils/log.js";

// Settings for a connection provider: from the environment first (local
// dev: backend/.env), else SSM under TALON_SSM_PREFIX in production.
// fields: { key: { env: "ENV_NAME", ssm: "parameter-name", required: true } }
// Returns a getter: () => settings object, or null while any required one
// is missing. A missing or unreadable result is retried after a minute, so
// adding the SSM parameters needs no restart.
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const retryMs = 60 * 1000;

export function createSettingsLoader({ name, fields, env = process.env, ssm = null, config = null, now = () => Date.now() }) {
  let cached = null; // { value, at }

  async function load() {
    if (config) {
      return config;
    }
    const values = Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, String(env[f.env] ?? "").trim()]));
    const missing = Object.keys(fields).filter((key) => !values[key] && fields[key].ssm);
    if (missing.length && env.NODE_ENV === "production") {
      const prefix = env.TALON_SSM_PREFIX || "/talon/demo";
      const client = ssm ?? new SSMClient({ region });
      const result = await client.send(new GetParametersCommand({
        Names: missing.map((key) => `${prefix}/${fields[key].ssm}`),
        WithDecryption: true,
      }));
      for (const key of missing) {
        values[key] = result.Parameters?.find((p) => p.Name === `${prefix}/${fields[key].ssm}`)?.Value?.trim() || "";
      }
    }
    const complete = Object.keys(fields).every((key) => !fields[key].required || values[key]);
    return complete ? values : null;
  }

  return async function getSettings() {
    if (cached && (cached.value || now() - cached.at < retryMs)) {
      return cached.value;
    }
    let value = null;
    try {
      value = await load();
    } catch (error) {
      log.warn(`cannot load ${name} settings`, { event: "connection.settings_failed", provider: name, error: error.message });
    }
    cached = { value, at: now() };
    return value;
  };
}
