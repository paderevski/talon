import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Google Drive API v3, read only, with a user's access token. Used by the
// Drive connection (browsing a picked folder) and the drive source (copying
// a folder into a job's snapshot). Drive has no paths: a folder's children
// are found by parent id, and a path inside a picked folder is walked one
// name at a time, so nothing outside the picked folder can be reached.

const driveApi = "https://www.googleapis.com/drive/v3";
export const folderMime = "application/vnd.google-apps.folder";
const fileFields = "id, name, mimeType, size, md5Checksum, modifiedTime";

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// Native Google files (Docs, Sheets, Slides, shortcuts...) have no bytes to
// download; only folders and ordinary files are used.
export const isNativeGoogleFile = (mimeType) =>
  String(mimeType || "").startsWith("application/vnd.google-apps.") && mimeType !== folderMime;

// Drive allows "/" and other oddities in names; on disk each name must be
// one plain path segment.
export function safeName(name) {
  const cleaned = String(name ?? "").replace(/[/\\\0]/g, "_").trim();
  return !cleaned || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}

// Folders that are never part of a job's code: hidden ones (.git, .venv,
// .ipynb_checkpoints...), caches, and any Python virtual environment
// (recognised by its pyvenv.cfg whatever it is called). Students' Drive
// folders often hold these; copying them is slow and useless.
const skippedFolderNames = new Set(["__pycache__", "node_modules"]);
export const isSkippedFolder = (name) => String(name).startsWith(".") || skippedFolderNames.has(String(name));

// Escapes a value for a Drive query string literal.
const quote = (value) => `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function createDriveClient({ token, fetch: fetchImpl = globalThis.fetch }) {
  const headers = { Authorization: `Bearer ${token}` };

  async function get(url) {
    const response = await fetchImpl(url, { headers });
    if (response.status === 401) {
      throw httpError("Google Drive access was revoked. Connect Google Drive again.", 409);
    }
    if (response.status === 404 || response.status === 403) {
      throw httpError("That Google Drive item cannot be read with your Google account", 400);
    }
    if (!response.ok) {
      throw httpError(`Google Drive answered ${response.status}`, 502);
    }
    return response;
  }

  async function getFile(id) {
    const params = new URLSearchParams({ fields: `${fileFields}, trashed`, supportsAllDrives: "true" });
    return (await get(`${driveApi}/files/${encodeURIComponent(id)}?${params}`)).json();
  }

  // Every child of a folder (not trashed), folders first then by name.
  async function listChildren(folderId, { limit = 5000 } = {}) {
    const files = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: `${quote(folderId)} in parents and trashed = false`,
        fields: `nextPageToken, files(${fileFields})`,
        orderBy: "folder,name",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      const data = await (await get(`${driveApi}/files?${params}`)).json();
      files.push(...(data.files ?? []));
      if (files.length > limit) {
        throw httpError(`A folder has more than ${limit} items`);
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return files;
  }

  // The folder at `relPath` ("week3/cnn") inside rootId, walking names one
  // at a time. Two folders with the same name: the first (by name order).
  async function resolveFolder(rootId, relPath) {
    let current = rootId;
    for (const segment of String(relPath || "").split("/").filter(Boolean)) {
      const children = await listChildren(current);
      const match = children.find((f) => f.mimeType === folderMime && (f.name === segment || safeName(f.name) === segment));
      if (!match) {
        throw httpError(`Folder not found: ${relPath}`);
      }
      current = match.id;
    }
    return current;
  }

  async function download(id, destination) {
    const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
    const response = await get(`${driveApi}/files/${encodeURIComponent(id)}?${params}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: "wx" }));
  }

  // Copies a folder tree into `dir`. Native Google files, skipped folders
  // (see isSkippedFolder) and anything past the limits are not copied.
  // onProgress(text) gets a few lines for the job's log. Returns
  // { files: [{ id, path, md5, modifiedTime, size }], skipped: [path] }.
  async function copyFolder(folderId, dir, { maxFiles, maxBytes, maxDepth = 20, concurrency = 8, onProgress = () => {}, signal = null }) {
    const checkCancelled = () => {
      if (signal?.aborted) {
        throw httpError("Cancelled", 499);
      }
    };
    const plan = [];
    const skipped = [];
    let bytes = 0;
    let folders = 0;
    const walk = async (id, rel, depth) => {
      if (depth > maxDepth) {
        throw httpError(`Folders are nested more than ${maxDepth} deep`);
      }
      checkCancelled();
      const children = await listChildren(id);
      // A virtual environment, whatever its name: skip the whole folder.
      if (rel && children.some((f) => f.name === "pyvenv.cfg" && f.mimeType !== folderMime)) {
        skipped.push(`${rel}/`);
        return;
      }
      folders += 1;
      const used = new Set();
      for (const file of children) {
        // Unique, safe names per folder ("notes.py", "notes (2).py").
        let name = safeName(file.name);
        for (let n = 2; used.has(name.toLowerCase()); n += 1) {
          const ext = path.extname(safeName(file.name));
          name = `${path.basename(safeName(file.name), ext)} (${n})${ext}`;
        }
        used.add(name.toLowerCase());
        const relPath = rel ? `${rel}/${name}` : name;
        if (file.mimeType === folderMime) {
          if (isSkippedFolder(file.name)) {
            skipped.push(`${relPath}/`);
          } else {
            await walk(file.id, relPath, depth + 1);
          }
        } else if (isNativeGoogleFile(file.mimeType)) {
          skipped.push(relPath);
        } else {
          bytes += Number(file.size || 0);
          if (plan.length + 1 > maxFiles) {
            throw httpError(`The folder has more than ${maxFiles} files`);
          }
          if (bytes > maxBytes) {
            throw httpError(`The folder is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
          }
          plan.push({ id: file.id, path: relPath, md5: file.md5Checksum || null, modifiedTime: file.modifiedTime || null, size: Number(file.size || 0) });
        }
      }
    };
    await walk(folderId, "", 0);
    const mb = (n) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    const skippedFolders = skipped.filter((p) => p.endsWith("/"));
    onProgress(`Found ${plan.length} file${plan.length === 1 ? "" : "s"} (${mb(bytes)}) in ${folders} folder${folders === 1 ? "" : "s"}`
      + (skippedFolders.length ? `; not copying ${skippedFolders.slice(0, 5).join(", ")}${skippedFolders.length > 5 ? ` and ${skippedFolders.length - 5} more` : ""}` : ""));

    let next = 0;
    let done = 0;
    let reported = 0;
    const started = Date.now();
    const worker = async () => {
      while (next < plan.length) {
        checkCancelled();
        const item = plan[next++];
        await download(item.id, path.join(dir, ...item.path.split("/")));
        done += 1;
        // About every 10 seconds, and at the end.
        if (done === plan.length || Date.now() - reported > 10_000) {
          reported = Date.now();
          onProgress(`Copied ${done} of ${plan.length} files (${Math.round((Date.now() - started) / 1000)} s)`);
        }
      }
    };
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: Math.min(concurrency, plan.length || 1) }, worker));
    return { files: plan, skipped };
  }

  return { getFile, listChildren, resolveFolder, download, copyFolder };
}
