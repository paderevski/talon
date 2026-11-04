import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFolder, parseGithubUrl } from "../../shared/src/repo.js";

test("parseGithubUrl reads repo, branch, folder and script", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/pytorch/examples"), { repo: "pytorch/examples" });
  assert.deepEqual(parseGithubUrl("pytorch/examples"), { repo: "pytorch/examples" });
  assert.deepEqual(parseGithubUrl("https://github.com/pytorch/examples/tree/main/mnist"), {
    repo: "pytorch/examples", branch: "main", folder: "mnist",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/pytorch/examples/tree/main/mnist/"), {
    repo: "pytorch/examples", branch: "main", folder: "mnist",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/pytorch/examples/tree/dev"), { repo: "pytorch/examples", branch: "dev" });
  assert.deepEqual(parseGithubUrl("https://github.com/pytorch/examples/blob/main/mnist/main.py"), {
    repo: "pytorch/examples", branch: "main", folder: "mnist", entryScript: "main.py",
  });
  assert.deepEqual(parseGithubUrl("github.com/o/r/blob/main/train.py"), { repo: "o/r", branch: "main", entryScript: "train.py" });
  assert.equal(parseGithubUrl("not a repo"), null);
});

test("normalizeFolder keeps plain relative folders only", () => {
  assert.equal(normalizeFolder(""), "");
  assert.equal(normalizeFolder("/"), "");
  assert.equal(normalizeFolder("./mnist/"), "mnist");
  assert.equal(normalizeFolder("a/b-c/d_e.1"), "a/b-c/d_e.1");
  assert.equal(normalizeFolder("a\\b"), "a/b");
  assert.equal(normalizeFolder("../x"), null);
  assert.equal(normalizeFolder("a/../b"), null);
  assert.equal(normalizeFolder("a//b"), null);
  assert.equal(normalizeFolder("a b"), null);
  assert.equal(normalizeFolder(".hidden"), null);
});
