import "./utils/asyncErrors.js";
import express from "express";
import jobsRouter from "./routes/jobs.js";
import repoRouter from "./routes/repo.js";
import resultsRouter from "./routes/results.js";
import authRouter from "./routes/auth.js";
import githubRouter from "./routes/github.js";
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
import { requestLogger } from "./utils/requestLog.js";

const app = express();
const port = Number(process.env.PORT || 5174);
// Loopback only: nginx (prod) and the Vite proxy (dev) are the only callers.
// Set TALON_BIND_HOST=0.0.0.0 only if something off-box must reach it directly.
const bindHost = String(process.env.TALON_BIND_HOST || "127.0.0.1").trim();

// nginx terminates client connections in front of us (needed for secure cookies).
app.set("trust proxy", 1);
app.use(requestLogger());
// No CORS: the frontend is same-origin (Vite proxy in dev, nginx in prod).
app.use(express.json({ limit: "512kb" })); // roster imports are the large bodies

app.get("/api/health", (_, res) => {
  res.json({ ok: true, service: "talon-backend" });
});

app.use("/api", createSessionMiddleware(), attachUser);

// Everything except /api/health and /api/auth requires a signed-in user.
app.use("/api/auth", authRouter);
app.use("/api/jobs", requireAuth, jobsRouter);
app.use("/api/repos", requireAuth, repoRouter);
app.use("/api/results", requireAuth, resultsRouter);
app.use("/api/github", githubRouter); // its own auth: the callback redirects instead of 401
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
    log,
  }).start(Number(process.env.EC2_RECONCILE_INTERVAL_MS || 45_000));
  log.info("EC2 jobs enabled: reconciler started", { event: "server.reconciler_started" });
}

app.listen(port, bindHost, () => {
  log.info(`Talon backend listening on http://${bindHost}:${port}`, { event: "server.started", port });
});
