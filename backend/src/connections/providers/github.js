import { getGithubApp } from "../../services/githubApp.js";
import { GithubAccountInUseError } from "../../utils/githubAccountsStore.js";

// GitHub as a connection provider (see ../registry.js for the interface).
// The work is done by services/githubApp.js; this maps it onto the shape
// every provider has.
export function createGithubProvider({ app = null } = {}) {
  const github = () => app ?? getGithubApp();

  return {
    id: "github",
    label: "GitHub",
    auth: "oauth",
    roles: ["code"],
    // The GitHub App has this callback registered (…/api/github/callback),
    // so its routes stay mounted there as well as under /api/connections.
    mountPath: "/api/github",
    modes: ["authorize", "install"],

    status: () => github().status(),

    async getLink(userId) {
      const link = await github().getLink(userId);
      if (!link) {
        return null;
      }
      const cfg = await github().getConfig();
      return {
        login: link.githubLogin,
        linkedAt: link.linkedAt,
        // Made with another GitHub App (e.g. dev vs box): connect again.
        needsReconnect: Boolean(cfg && link.clientId && link.clientId !== cfg.clientId),
      };
    },

    authorizeUrl: (state, mode) => github().authorizeUrl(state, mode === "install" ? "install" : "authorize"),

    // The query GitHub came back with -> result code for the panel.
    async completeCallback(userId, query) {
      const code = String(query.code ?? "");
      if (!code) {
        // e.g. repositories changed on an existing install without a new sign-in
        return query.installation_id ? "updated" : "denied";
      }
      try {
        await github().completeLink(userId, code);
        return "connected";
      } catch (error) {
        if (error instanceof GithubAccountInUseError) {
          return "in-use";
        }
        throw error;
      }
    },

    // What Talon can see: [{ id, label, private }].
    async listItems(userId) {
      const repos = await github().listRepos(userId);
      return repos.map((repo) => ({ id: repo.fullName, label: repo.fullName, private: repo.private }));
    },

    unlink: (userId) => github().unlink(userId),
  };
}
