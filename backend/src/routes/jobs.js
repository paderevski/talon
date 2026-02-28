import { Router } from "express";
import { jobs } from "../data/mockData.js";

const router = Router();

router.get("/", (req, res) => {
  const status = req.query.status;

  if (!status || status === "all") {
    return res.json({ items: jobs });
  }

  return res.json({ items: jobs.filter((job) => job.status === status) });
});

router.post("/", (req, res) => {
  const payload = req.body ?? {};

  const newJob = {
    id: `job-${jobs.length + 1}`,
    name: payload.name || "untitled-job",
    repo: payload.repo || "unknown/repo",
    status: "queued",
    gpu: "—",
    submitted: "just now",
    duration: "—",
  };

  jobs.unshift(newJob);

  return res.status(201).json({
    message: "Job queued",
    job: newJob,
  });
});

export default router;
