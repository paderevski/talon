import { Router } from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const usersFilePath = path.resolve(__dirname, "../data/users.txt");

async function loadUsers() {
  const contents = await readFile(usersFilePath, "utf8");
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [username, password] = line.split(":");
      return {
        username: username?.trim(),
        password: password?.trim(),
      };
    })
    .filter((entry) => entry.username && entry.password);
}

router.post("/login", async (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "").trim();

  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required" });
  }

  try {
    const users = await loadUsers();
    const matched = users.find((entry) => entry.username === username && entry.password === password);

    if (!matched) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    return res.json({
      ok: true,
      user: {
        username: matched.username,
      },
    });
  } catch {
    return res.status(500).json({ message: "Unable to validate credentials" });
  }
});

export default router;