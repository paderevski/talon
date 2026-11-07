import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDriveSource } from "./drive.js";
import { createGithubSource } from "./github.js";
import { packSnapshot, snapshotLimits } from "./snapshot.js";

// Sources: where a job's inputs come from (plan:
// docs/connections-and-sources-plan.md). A source type is an object with:
//
//   type, label         'github', 'GitHub repository'
//   roles               what it can supply: 'code' | 'data'
//   connection          provider id it signs in with (connections/), or null
//   runners             execution providers it works with ('local', 'ec2')
//   parse(input)        submit payload -> ref (plain JSON, stored on the
//                       job's input); throws 400 on bad input
//   describe(ref)       short label for lists ("owner/repo")
//   resolveAccess(userId, ref)      { credential, ref? }: what fetchInto
//                                   needs (or null), plus ref fields found
//                                   on the way (names, ids); throws 4xx when
//                                   the user may not use it
//   fetchInto(ref, dir, credential, { onProgress? })
//                                   fills dir with the files; returns extra
//                                   ref fields to record ({ commit });
//                                   onProgress(text) for the job's log
//
// Planned types (not registered yet): 'git' (any host), 'upload', 'home'.
// An unknown type is a 400.

const registry = new Map();
export function registerSource(source) {
  registry.set(source.type, source);
}
registerSource(createGithubSource());
registerSource(createDriveSource());

export const listSourceTypes = () => [...registry.values()];

export function getSourceType(type) {
  const source = registry.get(String(type ?? ""));
  if (!source) {
    const error = new Error(`Unknown code source: ${String(type).slice(0, 40)}`);
    error.status = 400;
    throw error;
  }
  return source;
}

// The job's code source from a submit payload. New clients send
// { source: { type, ...fields } }; older ones (and tests) send repo/branch
// at the top level, which means GitHub.
// Returns { type, ref, label }.
export function parseCodeSource(payload = {}) {
  const input = payload.source && typeof payload.source === "object"
    ? payload.source
    : { type: "github", repo: payload.repo, branch: payload.branch };
  const source = getSourceType(input.type || "github");
  if (!source.roles.includes("code")) {
    const error = new Error(`${source.label} cannot supply a job's code`);
    error.status = 400;
    throw error;
  }
  const ref = source.parse(input);
  return { type: source.type, ref, label: source.describe(ref) };
}

// Checks the user may use the source and gets what fetching needs.
// source: { type, ref, label } from parseCodeSource. Returns { source,
// credential } with ref fields the check found merged in and the label
// recomputed (a Drive folder's name is only known after asking Drive).
export async function resolveSourceAccess(userId, source) {
  const type = getSourceType(source.type);
  const access = (await type.resolveAccess(userId, source.ref)) ?? {};
  const ref = { ...source.ref, ...(access.ref ?? {}) };
  return { source: { type: source.type, ref, label: type.describe(ref) }, credential: access.credential ?? null };
}

// Fetches a code source and packs it as the job's snapshot (EC2 jobs).
// spec: { source: { type, ref, label }, credential, folder, entryScript,
//         onProgress?, signal? } (progress lines for the job; abort = cancelled)
// Returns { workDir, archive, bytes, sha256, ref } (ref with fetch results,
// e.g. the commit). The caller removes workDir.
export async function prepareCodeSnapshot(spec, limits = snapshotLimits()) {
  const source = getSourceType(spec?.source?.type);
  const workDir = await mkdtemp(path.join(os.tmpdir(), "talon-input-"));
  try {
    const codeDir = path.join(workDir, "repo");
    const onProgress = typeof spec.onProgress === "function" ? spec.onProgress : () => {};
    onProgress(`Fetching ${spec.source.label || source.label}`);
    const fetched = await source.fetchInto(spec.source.ref, codeDir, spec.credential ?? null, { onProgress, signal: spec.signal });
    if (spec.signal?.aborted) {
      throw Object.assign(new Error("Cancelled"), { status: 499 });
    }

    // The entry script must exist, inside the code folder.
    const folder = String(spec.folder || "");
    const script = path.resolve(codeDir, folder, String(spec.entryScript || ""));
    if (!script.startsWith(`${path.resolve(codeDir)}${path.sep}`)) {
      throw Object.assign(new Error("Entry script path escapes the code folder"), { status: 400 });
    }
    await stat(script).catch(() => {
      throw Object.assign(new Error(`Entry script not found: ${folder ? `${folder}/` : ""}${spec.entryScript}`), { status: 400 });
    });

    onProgress("Packing the code");
    const packed = await packSnapshot(codeDir, path.join(workDir, "repo.tgz"), limits);
    return { workDir, archive: packed.archive, bytes: packed.bytes, sha256: packed.sha256, ref: { ...spec.source.ref, ...(fetched ?? {}) } };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}
