import { normalizeDrivePath } from "talon-shared/repo";
import { getConnectionRegistry } from "../connections/registry.js";
import { createDriveClient, safeName } from "./fetchers/drive.js";
import { snapshotLimits } from "./snapshot.js";

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const driveIdPattern = /^[A-Za-z0-9_-]{10,200}$/;
const maxRecordedFiles = 1000;

// A folder (or file) the student picked in Google Drive, or a folder inside
// it. Only the chosen folder is copied into the job (not the picked folder
// around it), and the job runs from its top. What was copied is recorded:
// each file's Drive id, path, md5 and modified time.
// ref: { itemId, path, rootName, kind, folderId | fileId, files, fileCount, skipped }
export function createDriveSource({ provider = null, fetch: fetchImpl = undefined } = {}) {
  const drive = () => provider ?? getConnectionRegistry().get("google_drive");
  return {
    type: "drive",
    label: "Google Drive",
    roles: ["code"],
    connection: "google_drive",
    runners: ["local", "ec2"],

    // From the submit payload: { itemId, path }.
    parse(input = {}) {
      const itemId = String(input.itemId ?? "");
      if (!driveIdPattern.test(itemId)) {
        throw badRequest("Choose a Google Drive folder");
      }
      const path = normalizeDrivePath(input.path);
      if (path === null) {
        throw badRequest("That is not a folder path inside the Drive folder (like week3 or ML 2026/cnn)");
      }
      return { itemId, path };
    },

    describe: (ref) => `${ref.rootName || "Google Drive"}${ref.path ? `/${ref.path}` : ""}`,

    // The item must be one the student picked; the path must exist in it.
    async resolveAccess(userId, ref) {
      const located = await drive().locate(userId, ref.itemId, ref.path);
      return {
        credential: located.token,
        ref: {
          rootName: located.root.label,
          kind: located.root.kind,
          ...(located.folderId ? { folderId: located.folderId } : { fileId: located.root.id }),
        },
      };
    },

    // onProgress(text): a few lines for the job's log; signal: AbortSignal
    // that stops the copy (the job was cancelled).
    async fetchInto(ref, dir, token, { onProgress, signal } = {}) {
      const client = createDriveClient({ token, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
      const limits = snapshotLimits();
      let copied;
      if (ref.folderId) {
        copied = await client.copyFolder(ref.folderId, dir, { maxFiles: limits.maxFiles, maxBytes: limits.maxUnpackedBytes, onProgress, signal });
      } else {
        const file = await client.getFile(ref.fileId);
        const name = safeName(file.name);
        await client.download(file.id, `${dir}/${name}`);
        copied = { files: [{ id: file.id, path: name, md5: file.md5Checksum || null, modifiedTime: file.modifiedTime || null, size: Number(file.size || 0) }], skipped: [] };
      }
      return {
        fileCount: copied.files.length,
        files: copied.files.slice(0, maxRecordedFiles).map(({ size: _size, ...file }) => file),
        skipped: copied.skipped.slice(0, 100),
      };
    },
  };
}
