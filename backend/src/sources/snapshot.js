import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Every job runs from a snapshot: whatever the source (git clone, Drive
// download, an upload, a home folder), its files land in one directory,
// which is checked here and packed into one .tgz. The rules live here once,
// for every source:
//   - regular files, directories and symlinks only (no devices, fifos, sockets)
//   - symlinks must stay inside the tree (no absolute targets, no escaping ..)
//   - at most maxFiles entries and maxUnpackedBytes of file data
//   - the packed archive at most maxBytes
// Extracting an upload (zip-slip, zip bombs) gets the same checks: extract
// with limits into a directory, then pack it here.

export const snapshotLimits = () => ({
  maxBytes: Number(process.env.EC2_MAX_REPO_BYTES || 100 * 1024 * 1024),
  maxUnpackedBytes: Number(process.env.TALON_MAX_INPUT_UNPACKED_BYTES || 1024 * 1024 * 1024),
  maxFiles: Number(process.env.TALON_MAX_INPUT_FILES || 50_000),
});

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

// Walks `root` and enforces the rules above. Returns { files, unpackedBytes }.
export async function checkTree(root, { maxFiles, maxUnpackedBytes } = snapshotLimits()) {
  const base = path.resolve(root);
  let files = 0;
  let unpackedBytes = 0;
  const pending = [base];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(base, full);
      files += 1;
      if (files > maxFiles) {
        throw httpError(`The code has more than ${maxFiles} files`);
      }
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(full);
        const resolved = path.resolve(path.dirname(full), target);
        if (path.isAbsolute(target) || (resolved !== base && !resolved.startsWith(`${base}${path.sep}`))) {
          throw httpError(`${rel} links outside the code folder`);
        }
      } else if (entry.isFile()) {
        unpackedBytes += (await lstat(full)).size;
        if (unpackedBytes > maxUnpackedBytes) {
          throw httpError(`The code is larger than ${formatBytes(maxUnpackedBytes)} unpacked`);
        }
      } else {
        throw httpError(`${rel} is not a regular file`);
      }
    }
  }
  return { files, unpackedBytes };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

// Checks `dir` and packs it into `archive` (.tgz, paths relative to dir).
// Returns { archive, bytes, sha256, files }.
export async function packSnapshot(dir, archive, limits = snapshotLimits()) {
  const { files } = await checkTree(dir, limits);
  await execFileAsync("tar", ["-czf", archive, "-C", dir, "."], { timeout: 60 * 1000 });
  const bytes = (await stat(archive)).size;
  if (bytes > limits.maxBytes) {
    throw httpError(`The code is larger than ${formatBytes(limits.maxBytes)}`);
  }
  return { archive, bytes, sha256: await sha256File(archive), files };
}
