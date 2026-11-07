import "./utils/asyncErrors.js";
import express from "express";
import jobsRouter from "./routes/jobs.js";
import repoRouter from "./routes/repo.js";
import resultsRouter from "./routes/results.js";
import authRouter from "./routes/auth.js";
import { mountConnectionRoutes } from "./routes/connections.js";
import adminRouter from "./routes/admin.js";
import teacherRouter from "./routes/teacher.js";
import { createSessionMiddleware } from "./auth/session.js";
import { attachUser, requireAuth, requireRole } from "./auth/middleware.js";
import { warnIfDemoUsersInProduction } from "./db/demoUserCheck.js";
import { ec2JobsEnabled, getEc2Adapter } from "./services/jobExecutionService.js";
import { markJobAsExecutionLost, synchronizeJobFromExecution } from "./services/jobSync.js";
import { createEc2Reconciler } from "./services/ec2Reconciler.js";
import { getJobsRepository } from "./repositories/jobsRepository.js";
import { log } from "./utils/log.js";
import { getPool } from "./db/pool.js";
import { checkDatabase } from "./db/health.js";
import { lockIds, withTryAdvisoryLock } from "./db/advisoryLock.js";
import { trustedProxies } from "./utils/trustedProxies.js";
import { requestLogger } from "./utils/requestLog.js";

const app = express();
const port = Number(process.env.PORT || 5174);
// Loopback only: nginx (prod) and the Vite proxy (dev) are the only callers.
// Set TALON_BIND_HOST=0.0.0.0 only if something off-box must reach it directly.
const bindHost = String(process.env.TALON_BIND_HOST || "127.0.0.1").trim();

// Proxies whose X-Forwarded-* headers we believe: nginx on loopback, and in
// the VPC the load balancer in front of it (TALON_TRUSTED_PROXIES, set by
// infra/server/configure.sh). req.ip (login throttling, logs) is the first
// address in X-Forwarded-For that is not one of these; req.secure follows
// the X-Forwarded-Proto nginx passes on.
app.set("trust proxy", trustedProxies());
app.use(requestLogger());
// No CORS: the frontend is same-origin (Vite proxy in dev, nginx in prod).
app.use(express.json({ limit: "512kb" })); // roster imports are the large bodies

// The load balancer's health check (alb.tf): is this server's app up? Not
// the database: both servers share it, so a database outage is never fixed
// by routing elsewhere, and failing this check during one would get the
// Auto Scaling group to replace healthy servers (seen in a failover test,
// 2026-11-05). A server whose own database connections break recovers by
// itself (query_timeout in db/pool.js).
app.get("/api/health/live", (_, res) => {
  res.json({ ok: true, service: "talon-backend" });
});

// Full health, including the database: for people and scripts
// (infra/scripts/status.sh). 503 when this server cannot reach the database.
// No error details in the response (it is unauthenticated); the log has
// them, once per change.
let databaseWasHealthy = true;
async function checkDatabaseAndLog() {
  const database = await checkDatabase(getPool());
  if (database.ok !== databaseWasHealthy) {
    databaseWasHealthy = database.ok;
    if (database.ok) {
      log.info("health: database reachable again", { event: "health.database_recovered" });
    } else {
      log.error("health: database unreachable", { event: "health.database_failed", err: database.error });
    }
  }
  return database;
}
// Checked in the background too, so an outage is logged (and reaches the
// backend-errors alarm) even when nobody calls /api/health.
if (process.env.NODE_ENV === "production") {
  setInterval(() => checkDatabaseAndLog().catch(() => {}), 30_000).unref();
}

app.get("/api/health", async (_, res) => {
  const database = await checkDatabaseAndLog();
  res.status(database.ok ? 200 : 503).json({
    ok: database.ok,
    service: "talon-backend",
    database: database.ok ? "ok" : "unavailable",
  });
});

app.use("/api", createSessionMiddleware(), attachUser);

// Everything except /api/health and /api/auth requires a signed-in user.
app.use("/api/auth", authRouter);
app.use("/api/jobs", requireAuth, jobsRouter);
app.use("/api/repos", requireAuth, repoRouter);
app.use("/api/results", requireAuth, resultsRouter);
// /api/connections (and /api/github, where the GitHub App's callback is
// registered). Its own auth: the callbacks redirect instead of answering 401.
mountConnectionRoutes(app);
app.use("/api/admin", requireRole("admin"), adminRouter);
app.use("/api/teacher", requireRole("teacher"), teacherRouter);

// Last resort for errors that escape a route: log, and answer without details.
app.use((error, req, res, next) => {
  log.error("unhandled error", {
    event: "http.unhandled_error",
    requestId: req.id,
    method: req.method,
    path: req.originalUrl.split("?")[0],
    userId: req.user?.id,
    err: error,
  });
  if (res.headersSent) {
    return next(error);
  }
  return res.status(error?.status || 500).json({ message: "Internal server error" });
});

await warnIfDemoUsersInProduction();

if (ec2JobsEnabled()) {
  createEc2Reconciler({
    jobsRepository: await getJobsRepository(),
    adapter: getEc2Adapter(),
    sync: synchronizeJobFromExecution,
    markLost: markJobAsExecutionLost,
    // One web server at a time runs a tick; the others skip it.
    exclusive: (fn) => withTryAdvisoryLock(getPool(), lockIds.ec2Reconciler, fn),
    log,
  }).start(Number(process.env.EC2_RECONCILE_INTERVAL_MS || 45_000));
  log.info("EC2 jobs enabled: reconciler started", { event: "server.reconciler_started" });
}

app.listen(port, bindHost, () => {
  log.info(`Talon backend listening on http://${bindHost}:${port}`, { event: "server.started", port });
});
