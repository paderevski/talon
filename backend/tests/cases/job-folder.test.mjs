import { apiFetch, assert } from "../lib/harness.mjs";

export const name = "jobs store a folder inside the repo and refuse folders that leave it";

export async function run({ baseUrl }) {
  const submit = (body) => apiFetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "folder-test", repo: "octocat/Hello-World", branch: "master", entryScript: "x.py", ...body }),
  });

  for (const folder of ["../etc", "a/../../b", "a b"]) {
    const refused = await submit({ folder });
    assert(refused.status === 400, `folder ${JSON.stringify(folder)} should be 400, got ${refused.status}`);
  }

  const created = await submit({ folder: "/sub/dir/" });
  assert(created.status === 201, `Expected 201, got ${created.status}`);
  const { job } = await created.json();
  assert(job.folder === "sub/dir", `folder stored as ${JSON.stringify(job.folder)}`);

  const plain = await (await submit({})).json();
  assert(plain.job.folder === "", "no folder means the repo root");
}
