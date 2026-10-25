import express from "express";
import cors from "cors";
import jobsRouter from "./routes/jobs.js";
import repoRouter from "./routes/repo.js";
import resultsRouter from "./routes/results.js";
import authRouter from "./routes/auth.js";
import githubCredentialsRouter from "./routes/githubCredentials.js";
import adminRouter from "./routes/admin.js";
import teacherRouter from "./routes/teacher.js";

const app = express();
const port = Number(process.env.PORT || 5174);

app.use(cors());
app.use(express.json());

app.get("/api/health", (_, res) => {
  res.json({ ok: true, service: "talon-backend" });
});

app.use("/api/jobs", jobsRouter);
app.use("/api/repos", repoRouter);
app.use("/api/results", resultsRouter);
app.use("/api/auth", authRouter);
app.use("/api/github-credentials", githubCredentialsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/teacher", teacherRouter);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Talon backend listening on http://localhost:${port}`);
});
