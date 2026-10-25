import { Router } from "express";
import { getResultsRepository } from "../repositories/resultsRepository.js";
import { attachAccessScope, scopeAllows } from "../auth/access.js";

const router = Router();
router.use(attachAccessScope);

const resultsRepository = await getResultsRepository();

router.get("/", (req, res) => {
  res.json({
    items: resultsRepository
      .list()
      .filter((result) => scopeAllows(req.accessScope, result.ownerUsername)),
  });
});

export default router;
