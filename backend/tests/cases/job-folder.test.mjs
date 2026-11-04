import { apiFetch, assert } from "../lib/harness.mjs";

export const name = "jobs store a folder and script arguments; bad folders and arguments are refused";

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
  assert(plain.job.folder === "" && plain.job.scriptArgs === "", "no folder means the repo root, no arguments");

  const badArgs = await submit({ scriptArgs: '--name "unclosed' });
  assert(badArgs.status === 400, `unclosed quote should be 400, got ${badArgs.status}`);
  const withArgs = await (await submit({ scriptArgs: "  --save-model --epochs 3 " })).json();
  assert(withArgs.job.scriptArgs === "--save-model --epochs 3", `args stored as ${JSON.stringify(withArgs.job.scriptArgs)}`);
}
