import assert from "node:assert/strict";
import test from "node:test";
import { isRepoSegment, normalizeDrivePath, normalizeFolder, normalizeRepoPath, parseGithubUrl, splitRepoPath } from "../../shared/src/repo.js";

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

test("normalizeRepoPath accepts GitHub's forms and refuses dot names and other hosts", () => {
  for (const input of ["o/r", "o/r.git", "https://github.com/o/r", "https://github.com/o/r.git", "git@github.com:o/r.git", "github.com/o/r"]) {
    assert.equal(normalizeRepoPath(input), "o/r", input);
  }
  assert.equal(normalizeRepoPath("o/.github"), "o/.github");
  assert.deepEqual(splitRepoPath("o/r"), { owner: "o", repo: "r", path: "o/r" });
  // "." and ".." would walk up a GitHub API URL (/repos/o/.. is /repos).
  for (const input of ["o/..", "../r", "../..", "./r", "o/.", "o/...", "..", "o/r/x", "", "https://gitlab.com/o/r", "git@gitlab.com:o/r", "o r/x"]) {
    assert.equal(normalizeRepoPath(input), "", input);
  }
  assert.equal(splitRepoPath("o/.."), null);
  assert.equal(isRepoSegment(".."), false);
  assert.equal(isRepoSegment("a.b"), true);
});

test("parseGithubUrl survives a half-typed escape and odd URL parts", () => {
  // Typing "%20" passes through "%": the form must not throw on each keystroke.
  assert.doesNotThrow(() => parseGithubUrl("https://github.com/o/r/tree/main/a%"));
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/tree/main/a%"), { repo: "o/r", branch: "main" });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/tree/main/my%2Dfolder"), { repo: "o/r", branch: "main", folder: "my-folder" });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r?tab=readme#top"), { repo: "o/r" });
  assert.deepEqual(parseGithubUrl("https://www.github.com/o/r.git"), { repo: "o/r" });
  assert.equal(parseGithubUrl("https://gitlab.com/o/r"), null);
  assert.equal(parseGithubUrl("https://github.com/o/.."), null);
});

test("normalizeDrivePath keeps Drive names, refuses dots, control characters and oversize paths", () => {
  assert.equal(normalizeDrivePath(""), "");
  assert.equal(normalizeDrivePath("/ML 2026/week 3/"), "ML 2026/week 3");
  assert.equal(normalizeDrivePath(" a / b "), "a/b");
  for (const input of ["a/../b", "a/./b", "..", "a//b", "a\\b", "a\u0000b", "a\u007fb", "x".repeat(256), Array(21).fill("a").join("/"), "a/".repeat(2100)]) {
    assert.equal(normalizeDrivePath(input), null, JSON.stringify(input.slice(0, 40)));
  }
  assert.equal(normalizeDrivePath(Array(20).fill("a").join("/")), Array(20).fill("a").join("/"));
});

test("path normalizers stay fast on a long run of slashes", () => {
  const started = Date.now();
  assert.equal(normalizeFolder("/".repeat(4000)), "");
  assert.equal(normalizeDrivePath("/".repeat(4000)), "");
  assert.ok(Date.now() - started < 100, "took too long");
});
