import { Router } from "express";
import { getJobsRepository } from "../repositories/jobsRepository.js";
import { attachAccessScope, narrowScopeToOwner } from "../auth/access.js";

const router = Router();
router.use(attachAccessScope);

const jobsRepository = await getJobsRepository();

router.get("/", async (req, res) => {
  res.json({ items: await jobsRepository.listResults(narrowScopeToOwner(req.accessScope, req.query.owner)) });
});

export default router;
