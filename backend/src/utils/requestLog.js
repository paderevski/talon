import { randomUUID } from "node:crypto";
import { log } from "./log.js";

// One log line per API request (event "http.request"), written when the
// response finishes. Each request gets an id: nginx's $request_id when it
// sends one (so nginx and backend lines match), otherwise a new one. It is
// returned in the X-Request-Id response header.
//
// Logs the path without the query string (the GitHub callback's query holds
// an OAuth code), never headers or bodies.

const requestIdPattern = /^[A-Za-z0-9_-]{8,64}$/;
const jobIdPattern = /\/jobs\/(job-\d+)(?:\/|$)/;

export function requestId(req) {
  const incoming = String(req.get("x-request-id") || "");
  return requestIdPattern.test(incoming) ? incoming : randomUUID();
}

export function requestLogger({ quietPaths = ["/api/health", "/api/health/live"] } = {}) {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    req.id = requestId(req);
    res.set("X-Request-Id", req.id);

    res.on("finish", () => {
      const path = req.originalUrl.split("?")[0];
      const status = res.statusCode;
      const fields = {
        event: "http.request",
        requestId: req.id,
        method: req.method,
        path,
        status,
        durationMs: Number((process.hrtime.bigint() - startedAt) / 1000n) / 1000,
        userId: req.user?.id,
        jobId: jobIdPattern.exec(path)?.[1],
        ip: req.ip,
      };
      if (quietPaths.includes(path) && status < 400) {
        log.debug("request", fields);
      } else if (status >= 500) {
        log.warn("request failed", fields);
      } else {
        log.info("request", fields);
      }
    });

    next();
  };
}
