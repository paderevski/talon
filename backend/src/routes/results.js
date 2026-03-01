import { Router } from "express";
import { getResultsRepository } from "../repositories/resultsRepository.js";

const router = Router();

const resultsRepository = await getResultsRepository();

router.get("/", (_, res) => {
  res.json({ items: resultsRepository.list() });
});

export default router;
