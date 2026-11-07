import { normalizeRepoPath } from "talon-shared/repo";
import { getGithubApp } from "../services/githubApp.js";
import { assertBranch, cloneInto } from "./fetchers/git.js";

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// A repository on github.com: private ones through the GitHub connection
// (the user's token is the access check, an installation token clones),
// public ones anonymously. The submit form's "GitHub" and "Public
// repository" choices are both this source.
// ref: { host: "github.com", repo: "owner/repo", branch, commit? }
export function createGithubSource({ app = null } = {}) {
  const github = () => app ?? getGithubApp();
  return {
    type: "github",
    label: "GitHub repository",
    roles: ["code"],
    connection: "github", // optional: public repos need none
    // The local runner needs a git checkout (it reports changed files with
    // git status), so only git sources run there.
    runners: ["local", "ec2"],

    // From the submit payload: { repo, branch }.
    parse(input = {}) {
      const repo = normalizeRepoPath(input.repo);
      if (!repo) {
        throw badRequest("Invalid repository format. Expected owner/repo");
      }
      return { host: "github.com", repo, branch: assertBranch(input.branch) };
    },

    describe: (ref) => ref.repo,

    // The token to clone with, or null (anonymous). Throws 4xx when the
    // user may not use the repo.
    resolveAccess: (userId, ref) => github().resolveCloneToken(userId, ref.repo),

    // Fills `dir` with the repo's files. Returns { commit }.
    fetchInto: (ref, dir, credential) => cloneInto({ host: ref.host, repoPath: ref.repo, branch: ref.branch, token: credential, dir }),
  };
}
