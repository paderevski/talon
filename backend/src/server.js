import express from "express";
import jobsRouter from "./routes/jobs.js";
import repoRouter from "./routes/repo.js";
import resultsRouter from "./routes/results.js";
import authRouter from "./routes/auth.js";
import githubCredentialsRouter from "./routes/githubCredentials.js";
import adminRouter from "./routes/admin.js";
import teacherRouter from "./routes/teacher.js";
import { createSessionMiddleware } from "./auth/session.js";
import { attachUser, requireAuth, requireRole } from "./auth/middleware.js";
import { warnIfDemoUsersInProduction } from "./db/demoUserCheck.js";

const app = express();
const port = Number(process.env.PORT || 5174);
// Loopback only: nginx (prod) and the Vite proxy (dev) are the only callers.
// Set TALON_BIND_HOST=0.0.0.0 only if something off-box must reach it directly.
const bindHost = String(process.env.TALON_BIND_HOST || "127.0.0.1").trim();

// nginx terminates client connections in front of us (needed for secure cookies).
app.set("trust proxy", 1);
// No CORS: the frontend is same-origin (Vite proxy in dev, nginx in prod).
app.use(express.json());

app.get("/api/health", (_, res) => {
  res.json({ ok: true, service: "talon-backend" });
});

app.use("/api", createSessionMiddleware(), attachUser);

// Everything except /api/health and /api/auth requires a signed-in user.
app.use("/api/auth", authRouter);
app.use("/api/jobs", requireAuth, jobsRouter);
app.use("/api/repos", requireAuth, repoRouter);
app.use("/api/results", requireAuth, resultsRouter);
app.use("/api/github-credentials", requireAuth, githubCredentialsRouter);
app.use("/api/admin", requireRole("admin"), adminRouter);
app.use("/api/teacher", requireRole("teacher"), teacherRouter);

if (String(process.env.USERS_REPOSITORY_PROVIDER || "").toLowerCase() === "postgres") {
  await warnIfDemoUsersInProduction();
}

app.listen(port, bindHost, () => {
  // eslint-disable-next-line no-console
  console.log(`Talon backend listening on http://${bindHost}:${port}`);
});
