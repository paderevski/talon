import { createGithubProvider } from "./providers/github.js";
import { createGoogleDriveProvider } from "./providers/googleDrive.js";

// Connection providers: outside accounts a user can link (plan:
// docs/connections-and-sources-plan.md). Each provider is an object with:
//
//   id, label            'github', 'GitHub'
//   auth                 'oauth' (browser round trip) | 'token' (pasted key, later)
//   roles                what it can serve: 'code' | 'data' | 'results'
//   mountPath            optional extra mount for its routes (GitHub's
//                        registered callback lives under /api/github)
//   modes                connect modes the router accepts (first = default)
//   status()             { configured }: off when the server has no settings
//   getLink(userId)      { login, linkedAt, needsReconnect } | null
//   authorizeUrl(state, mode)          where Connect sends the browser
//   completeCallback(userId, query)    result code: connected | updated | denied | in-use | missing-scope
//   listItems(userId)    what Talon can see: [{ id, label, private, kind? }]
//   unlink(userId)
//   extendRouter(router, { requireAuth })   optional extra routes under
//                        /api/connections/<id>/ (Google: /picker)
//
// Built-in sources (public repos, uploads, a home folder) need no account
// and are not connections; they live in ../sources.
export function createConnectionRegistry(providers = [createGithubProvider(), createGoogleDriveProvider()]) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(String(id ?? "")) ?? null,
    // For GET /api/connections: every provider, configured or not.
    describeFor: (userId) => Promise.all([...byId.values()].map((provider) => describeProvider(provider, userId))),
  };
}

// What the Connections panel shows for one provider and user.
export async function describeProvider(provider, userId) {
  const { configured } = await provider.status();
  const link = configured ? await provider.getLink(userId) : null;
  return {
    provider: provider.id,
    label: provider.label,
    auth: provider.auth,
    roles: provider.roles,
    configured,
    linked: Boolean(link),
    account: link ? { login: link.login, linkedAt: link.linkedAt } : null,
    needsReconnect: Boolean(link?.needsReconnect),
  };
}

let defaultRegistry = null;
export const getConnectionRegistry = () => (defaultRegistry ??= createConnectionRegistry());
