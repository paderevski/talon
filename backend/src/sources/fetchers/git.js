import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertGitHost, describeCloneError, gitAuthEnv } from "../../execution/gitAuth.js";

const execFileAsync = promisify(execFile);
const gitBin = () => process.env.TALON_GIT_BIN || "git";
const defaultTimeoutMs = () => Number(process.env.EC2_GIT_CLONE_TIMEOUT_MS || 90 * 1000);

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Branch names go on git's command line (never a shell), but keep them plain.
export function assertBranch(branch) {
  const value = String(branch || "main").trim() || "main";
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) || value.includes("..")) {
    throw httpError("Branch name is invalid", 400);
  }
  return value;
}

// Fetcher for every git source (GitHub today; GitLab, Bitbucket or any
// public git host later): a shallow clone of one branch into `dir`, then
// .git is removed so the snapshot holds the files only.
// repoPath: "owner/repo" (validated by the source). token: sent to `host`
// only, via git's environment config. Returns { commit }.
export async function cloneInto({ host = "github.com", repoPath, branch, token = null, dir, timeoutMs = defaultTimeoutMs(), hint }) {
  const safeHost = assertGitHost(host);
  const safeBranch = assertBranch(branch);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", ...gitAuthEnv(token, safeHost) };
  await execFileAsync(
    gitBin(),
    ["clone", "--depth", "1", "--branch", safeBranch, `https://${safeHost}/${repoPath}.git`, dir],
    { cwd: path.dirname(dir), timeout: timeoutMs, env },
  ).catch((error) => {
    throw httpError(`Could not clone ${repoPath}@${safeBranch}: ${describeCloneError(String(error.stderr || error.message), hint ? { hint } : undefined)}`, 400);
  });
  const { stdout } = await execFileAsync(gitBin(), ["-C", dir, "rev-parse", "HEAD"], { timeout: 10 * 1000 });
  await rm(path.join(dir, ".git"), { recursive: true, force: true });
  const commit = String(stdout).trim();
  return { commit: /^[0-9a-f]{40,64}$/.test(commit) ? commit : null };
}
