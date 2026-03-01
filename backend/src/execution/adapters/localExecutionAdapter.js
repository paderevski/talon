import { spawn } from "node:child_process";
import {
  mkdir,
  readdir,
  stat,
  writeFile,
  appendFile,
  access,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendSrcDir = path.resolve(__dirname, "../../../");
const runsRootDir = path.resolve(backendSrcDir, "data", "runs");

const maxConcurrentJobs = Number(process.env.LOCAL_MAX_CONCURRENT_JOBS || 1);
const pythonBin = process.env.TALON_PYTHON_BIN || "python3";
const gitBin = process.env.TALON_GIT_BIN || "git";
const maxArtifactFileBytes = Number(
  process.env.LOCAL_MAX_ARTIFACT_BYTES || 50 * 1024 * 1024,
);
const excludedArtifactPrefixes = [
  ".git/",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
];

function makeExecutionId() {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function assertRepoFormat(repo) {
  const normalized = String(repo ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("Invalid repository format. Expected owner/repo");
  }
  return normalized;
}

function assertEntryScriptPath(entryScript) {
  const normalized = String(entryScript ?? "").trim();
  if (!normalized) {
    throw new Error("Entry script is required");
  }
  if (path.isAbsolute(normalized) || normalized.includes("..")) {
    throw new Error("Entry script path is invalid");
  }
  return normalized;
}

function splitIntoLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

function formatBytes(bytes) {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

async function listFilesRecursive(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(rootDir, absolutePath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const fileStats = await stat(absolutePath);
    files.push({
      name: path.relative(rootDir, absolutePath),
      size: formatBytes(fileStats.size),
      bytes: fileStats.size,
      modifiedAt: fileStats.mtime.toISOString(),
    });
  }

  return files;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        code: Number(code ?? 1),
        signal: signal || null,
        stdout,
        stderr,
      });
    });
  });
}

function isArtifactPathAllowed(relativePath) {
  const normalizedPath = String(relativePath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");

  if (!normalizedPath) {
    return false;
  }

  return !excludedArtifactPrefixes.some((prefix) =>
    normalizedPath.startsWith(prefix),
  );
}

function parseGitStatusFilePath(line) {
  const raw = String(line ?? "").trim();
  if (!raw) {
    return "";
  }

  const withoutStatus = raw.slice(3).trim();
  if (!withoutStatus) {
    return "";
  }

  if (withoutStatus.includes(" -> ")) {
    const parts = withoutStatus.split(" -> ");
    return parts[parts.length - 1]?.trim() || "";
  }

  return withoutStatus;
}

async function listRepoChangedFiles(record) {
  const result = await runProcess(
    gitBin,
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: record.repoDir },
  );

  if (result.code !== 0) {
    return [];
  }

  const candidatePaths = splitIntoLines(result.stdout)
    .map((line) => parseGitStatusFilePath(line))
    .filter(Boolean)
    .filter((relativePath) => isArtifactPathAllowed(relativePath));

  const files = [];

  for (const relativePath of candidatePaths) {
    const absolutePath = path.resolve(record.repoDir, relativePath);
    if (!absolutePath.startsWith(record.repoDir)) {
      continue;
    }

    try {
      const fileStats = await stat(absolutePath);
      if (!fileStats.isFile()) {
        continue;
      }
      if (fileStats.size > maxArtifactFileBytes) {
        continue;
      }

      files.push({
        name: relativePath,
        size: formatBytes(fileStats.size),
        bytes: fileStats.size,
        modifiedAt: fileStats.mtime.toISOString(),
        source: "repo_changed",
      });
    } catch {
      // Ignore deleted/missing files.
    }
  }

  return files;
}

async function listOutputArtifacts(record) {
  const outputFiles = await listFilesRecursive(record.outputDir);
  const normalizedOutputFiles = outputFiles.map((file) => ({
    ...file,
    source: "output_dir",
  }));

  const repoChangedFiles = await listRepoChangedFiles(record);

  const seen = new Set();
  const merged = [];

  for (const file of [...normalizedOutputFiles, ...repoChangedFiles]) {
    const dedupeKey = `${file.source}:${file.name}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    merged.push(file);
  }

  return merged;
}

export default function createLocalExecutionAdapter() {
  const executionRecords = new Map();
  const queue = [];
  let runningCount = 0;

  const persistLine = async (record, line, stream) => {
    const timestamp = new Date().toISOString();
    const text = `[${timestamp}] [${stream}] ${line}`;
    record.logLines.push(text);
    record.nextCursor = record.logLines.length;
    await appendFile(record.combinedLogPath, `${text}\n`, "utf8");
  };

  const runQueuedExecution = async (executionId) => {
    const record = executionRecords.get(executionId);
    if (!record) {
      return;
    }

    record.state = "running";
    record.startedAt = new Date().toISOString();

    try {
      await mkdir(record.runDir, { recursive: true });
      await mkdir(record.outputDir, { recursive: true });
      await writeFile(record.combinedLogPath, "", "utf8");

      const cloneUrl = `https://github.com/${record.jobSpec.repo}.git`;
      const cloneSpawn = spawn(
        gitBin,
        [
          "clone",
          "--depth",
          "1",
          "--branch",
          record.jobSpec.branch,
          cloneUrl,
          record.repoDir,
        ],
        { cwd: record.runDir },
      );

      cloneSpawn.stdout?.on("data", (chunk) => {
        splitIntoLines(chunk.toString("utf8")).forEach((line) => {
          void persistLine(record, line, "git");
        });
      });

      cloneSpawn.stderr?.on("data", (chunk) => {
        splitIntoLines(chunk.toString("utf8")).forEach((line) => {
          void persistLine(record, line, "git");
        });
      });

      const cloneExit = await new Promise((resolve) => {
        cloneSpawn.on("close", (code, signal) =>
          resolve({ code: Number(code ?? 1), signal: signal || null }),
        );
        cloneSpawn.on("error", () => resolve({ code: 1, signal: null }));
      });

      if (cloneExit.code !== 0) {
        record.state = "failed";
        record.exitCode = cloneExit.code;
        record.endedAt = new Date().toISOString();
        return;
      }

      const scriptRelativePath = assertEntryScriptPath(
        record.jobSpec.entryScript,
      );
      const scriptAbsolutePath = path.resolve(
        record.repoDir,
        scriptRelativePath,
      );
      if (!scriptAbsolutePath.startsWith(record.repoDir)) {
        record.state = "failed";
        record.exitCode = 1;
        record.endedAt = new Date().toISOString();
        await persistLine(
          record,
          "Entry script path escapes repository directory",
          "system",
        );
        return;
      }

      try {
        await access(scriptAbsolutePath, fsConstants.R_OK);
      } catch {
        record.state = "failed";
        record.exitCode = 1;
        record.endedAt = new Date().toISOString();
        await persistLine(
          record,
          `Entry script not found: ${scriptRelativePath}`,
          "system",
        );
        return;
      }

      const processHandle = spawn(pythonBin, [scriptRelativePath], {
        cwd: record.repoDir,
        env: {
          ...process.env,
          TALON_OUTPUT_DIR: record.outputDir,
        },
      });

      record.process = processHandle;

      processHandle.stdout?.on("data", (chunk) => {
        splitIntoLines(chunk.toString("utf8")).forEach((line) => {
          void persistLine(record, line, "stdout");
        });
      });

      processHandle.stderr?.on("data", (chunk) => {
        splitIntoLines(chunk.toString("utf8")).forEach((line) => {
          void persistLine(record, line, "stderr");
        });
      });

      const processExit = await new Promise((resolve) => {
        processHandle.on("close", (code, signal) =>
          resolve({ code: Number(code ?? 1), signal: signal || null }),
        );
        processHandle.on("error", () => resolve({ code: 1, signal: null }));
      });

      record.exitCode = processExit.code;
      record.endedAt = new Date().toISOString();
      record.process = null;

      if (record.cancelRequested) {
        record.state = "cancelled";
        return;
      }

      record.state = processExit.code === 0 ? "completed" : "failed";
    } catch (error) {
      record.state = record.cancelRequested ? "cancelled" : "failed";
      record.endedAt = new Date().toISOString();
      record.exitCode = 1;
      await persistLine(record, error?.message || "Execution failed", "system");
    }
  };

  const pumpQueue = () => {
    while (runningCount < maxConcurrentJobs && queue.length > 0) {
      const nextExecutionId = queue.shift();
      if (!nextExecutionId) {
        return;
      }

      runningCount += 1;
      void runQueuedExecution(nextExecutionId).finally(() => {
        runningCount -= 1;
        pumpQueue();
      });
    }
  };

  return {
    provider: "local",

    async start(jobSpec) {
      const normalizedRepo = assertRepoFormat(jobSpec?.repo);
      const normalizedBranch =
        String(jobSpec?.branch || "main").trim() || "main";
      const normalizedEntryScript = assertEntryScriptPath(jobSpec?.entryScript);

      const executionId = makeExecutionId();
      const runDir = path.resolve(runsRootDir, executionId);
      const repoDir = path.resolve(runDir, "repo");
      const outputDir = path.resolve(runDir, "output");
      const combinedLogPath = path.resolve(runDir, "combined.log");

      const executionRef = {
        provider: "local",
        executionId,
        submittedAt: new Date().toISOString(),
      };

      executionRecords.set(executionId, {
        executionRef,
        state: "queued",
        queuedAt: new Date().toISOString(),
        startedAt: null,
        endedAt: null,
        exitCode: null,
        process: null,
        cancelRequested: false,
        logLines: [],
        nextCursor: 0,
        runDir,
        repoDir,
        outputDir,
        combinedLogPath,
        jobSpec: {
          name: String(jobSpec?.name || "untitled-job"),
          repo: normalizedRepo,
          branch: normalizedBranch,
          entryScript: normalizedEntryScript,
        },
      });

      queue.push(executionId);
      pumpQueue();
      return executionRef;
    },

    async getStatus(executionRef) {
      const executionId = String(executionRef?.executionId || "").trim();
      const record = executionRecords.get(executionId);

      if (!record) {
        const error = new Error("Execution not found");
        error.status = 404;
        throw error;
      }

      return {
        state: record.state,
        submittedAt: record.executionRef.submittedAt,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        exitCode: record.exitCode,
      };
    },

    async getLogs(executionRef, cursor = 0) {
      const executionId = String(executionRef?.executionId || "").trim();
      const record = executionRecords.get(executionId);

      if (!record) {
        const error = new Error("Execution not found");
        error.status = 404;
        throw error;
      }

      const offset = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
      const lines = record.logLines.slice(offset);

      return {
        lines,
        nextCursor: offset + lines.length,
      };
    },

    async listOutputFiles(executionRef) {
      const executionId = String(executionRef?.executionId || "").trim();
      const record = executionRecords.get(executionId);

      if (!record) {
        const error = new Error("Execution not found");
        error.status = 404;
        throw error;
      }

      try {
        return await listOutputArtifacts(record);
      } catch {
        return [];
      }
    },

    async cancel(executionRef) {
      const executionId = String(executionRef?.executionId || "").trim();
      const record = executionRecords.get(executionId);

      if (!record) {
        const error = new Error("Execution not found");
        error.status = 404;
        throw error;
      }

      record.cancelRequested = true;

      if (record.state === "queued") {
        const index = queue.indexOf(executionId);
        if (index >= 0) {
          queue.splice(index, 1);
        }
        record.state = "cancelled";
        record.endedAt = new Date().toISOString();
        return { ok: true, state: record.state };
      }

      if (record.state === "running" && record.process) {
        record.process.kill("SIGTERM");
        return { ok: true, state: "cancelling" };
      }

      return { ok: true, state: record.state };
    },

    async getDebugSnapshot() {
      const executions = Array.from(executionRecords.values()).map(
        (record) => ({
          executionId: record.executionRef.executionId,
          state: record.state,
          repo: record.jobSpec.repo,
          branch: record.jobSpec.branch,
          entryScript: record.jobSpec.entryScript,
          queuedAt: record.queuedAt,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          cancelRequested: record.cancelRequested,
          exitCode: record.exitCode,
        }),
      );

      return {
        provider: "local",
        maxConcurrentJobs,
        runningCount,
        queuedCount: queue.length,
        queuedExecutionIds: [...queue],
        executions,
      };
    },
  };
}
