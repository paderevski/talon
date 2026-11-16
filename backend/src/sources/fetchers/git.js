import { execFile } from "node:child_process";
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertGitHost, describeCloneError, gitAuthEnv } from "../../execution/gitAuth.js";

const execFileAsync = promisify(execFile);
const gitBin = () => process.env.TALON_GIT_BIN || "git";
const defaultTimeoutMs = () => Number(process.env.EC2_GIT_CLONE_TIMEOUT_MS || 90 * 1000);

// The clone folder (the .git objects plus the checkout) may grow to this
// size while cloning; each is up to the unpacked limit, hence twice it.
const defaultMaxCloneBytes = () => Number(process.env.TALON_MAX_CLONE_BYTES || 2 * 1024 * 1024 * 1024);
const defaultPollMs = () => Number(process.env.TALON_CLONE_SIZE_POLL_MS || 1000);

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

// Total bytes of the files under `dir` (0 if it does not exist yet).
async function directoryBytes(dir) {
  let total = 0;
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else {
        total += (await lstat(full).catch(() => null))?.size ?? 0;
      }
    }
  }
  return total;
}

// Fetcher for every git source (GitHub today; GitLab, Bitbucket or any
// public git host later): a shallow clone of one branch into `dir`, then
// .git is removed so the snapshot holds the files only.
// repoPath: "owner/repo" (validated by the source). token: sent to `host`
// only, via git's environment config. The clone is stopped (and `dir`
// removed) if `dir` grows past maxBytes while it runs. Returns { commit }.
export async function cloneInto({ host = "github.com", repoPath, branch, token = null, dir, timeoutMs = defaultTimeoutMs(), maxBytes = defaultMaxCloneBytes(), pollMs = defaultPollMs(), hint }) {
  const safeHost = assertGitHost(host);
  const safeBranch = assertBranch(branch);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", ...gitAuthEnv(token, safeHost) };
  const clone = execFileAsync(
    gitBin(),
    ["clone", "--depth", "1", "--branch", safeBranch, `https://${safeHost}/${repoPath}.git`, dir],
    // Own process group, so stopping the clone also stops git's helpers.
    { cwd: path.dirname(dir), timeout: timeoutMs, env, detached: true },
  );
  let tooBig = false;
  let measuring = false;
  const watcher = setInterval(async () => {
    if (measuring || tooBig) {
      return;
    }
    measuring = true;
    if ((await directoryBytes(dir)) > maxBytes) {
      tooBig = true;
      try { process.kill(-clone.child.pid, "SIGKILL"); } catch { clone.child.kill("SIGKILL"); }
    }
    measuring = false;
  }, pollMs);
  try {
    await clone;
  } catch (error) {
    if (tooBig) {
      await rm(dir, { recursive: true, force: true });
      throw httpError(`${repoPath}@${safeBranch} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB. Remove large files from the repository (or keep data and videos out of it).`, 400);
    }
    throw httpError(`Could not clone ${repoPath}@${safeBranch}: ${describeCloneError(String(error.stderr || error.message), hint ? { hint } : undefined)}`, 400);
  } finally {
    clearInterval(watcher);
  }
  const { stdout } = await execFileAsync(gitBin(), ["-C", dir, "rev-parse", "HEAD"], { timeout: 10 * 1000 });
  await rm(path.join(dir, ".git"), { recursive: true, force: true });
  const commit = String(stdout).trim();
  return { commit: /^[0-9a-f]{40,64}$/.test(commit) ? commit : null };
}
