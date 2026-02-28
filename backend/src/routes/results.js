import { Router } from "express";
import { results } from "../data/mockData.js";

const router = Router();

router.get("/", (_, res) => {
  res.json({ items: results });
});

export default router;
