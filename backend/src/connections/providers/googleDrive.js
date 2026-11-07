import { ConnectionInUseError, createConnectionsStore } from "../store.js";
import { createSettingsLoader } from "../settings.js";
import { tokenPurposes } from "../tokenPurposes.js";
import { log } from "../../utils/log.js";
import { normalizeDrivePath } from "talon-shared/repo";
import { createDriveClient, folderMime, isNativeGoogleFile, isSkippedFolder, safeName } from "../../sources/fetchers/drive.js";

// Google Drive as a connection provider (plan:
// docs/connections-and-sources-plan.md, "Google Drive").
//
// Sign-in is Google OAuth (web server flow, offline access) with scope
// drive.readonly. The narrower drive.file was tried first (2026-11-06): a
// folder picked under it is shared without its contents, and job code lives
// in folders. So Google grants read access to the whole Drive, and Talon
// limits itself: it only reads items the student picked with the Google
// Picker in the Connections panel, kept in connection_items (and, later,
// what is inside picked folders). The refresh token is stored encrypted
// (connections, provider google_drive); access tokens last an hour and are
// refreshed here.
//
// Settings, from the environment first (local dev), else SSM under
// TALON_SSM_PREFIX:
//   GOOGLE_OAUTH_CLIENT_ID      google-oauth-client-id      (String, Terraform)
//   GOOGLE_PROJECT_NUMBER       google-project-number       (String, Terraform; the Picker's app id;
//                               optional: the client id starts with it. Must be the
//                               project NUMBER, not the project ID, or picked files
//                               are not shared with Talon)
//   GOOGLE_PICKER_API_KEY       google-picker-api-key       (String, Terraform; sent to browsers, restrict it by referrer)
//   GOOGLE_OAUTH_CLIENT_SECRET  google-oauth-client-secret  (SecureString, by hand)
//   TALON_PUBLIC_URL            public-url                  (shared with GitHub)
// Without them the card says "not set up".

const authBase = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenUrl = "https://oauth2.googleapis.com/token";
const revokeUrl = "https://oauth2.googleapis.com/revoke";
const userInfoUrl = "https://openidconnect.googleapis.com/v1/userinfo";
const driveApi = "https://www.googleapis.com/drive/v3";
export const driveScope = "https://www.googleapis.com/auth/drive.readonly";
const scopes = ["openid", "email", driveScope];
const maxPickedPerUser = 200;
const driveIdPattern = /^[A-Za-z0-9_-]{10,200}$/;

const kindOf = (mimeType) => {
  const mime = String(mimeType || "");
  if (mime === "application/vnd.google-apps.folder") return "folder";
  return mime.startsWith("application/vnd.google-apps.") ? "google-doc" : "file";
};
const hasDriveScope = (scope) => String(scope || "").split(/\s+/).includes(driveScope);
const refreshMarginMs = 5 * 60 * 1000;
export const callbackPath = "/api/connections/google_drive/callback";

// The Picker's app id is the project NUMBER of the OAuth client's project.
// With anything else (e.g. the project ID) the Picker still works but the
// picked files are not shared with Talon. OAuth client ids start with it.
export function pickerAppId(cfg) {
  const configured = String(cfg.projectNumber || "").trim();
  if (/^\d+$/.test(configured)) {
    return configured;
  }
  const fromClient = String(cfg.clientId || "").split("-")[0];
  if (configured) {
    log.warn("GOOGLE_PROJECT_NUMBER is not a project number; using the client id's", { event: "google_drive.bad_project_number" });
  }
  return /^\d+$/.test(fromClient) ? fromClient : configured;
}

function httpError(message, status, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

export function createGoogleDriveProvider({
  settings = null, // full settings object (tests); default: environment, then SSM
  env = process.env,
  ssm = null,
  store = null,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const loadSettings = createSettingsLoader({
    name: "google_drive",
    env,
    ssm,
    config: settings,
    now,
    fields: {
      clientId: { env: "GOOGLE_OAUTH_CLIENT_ID", ssm: "google-oauth-client-id", required: true },
      clientSecret: { env: "GOOGLE_OAUTH_CLIENT_SECRET", ssm: "google-oauth-client-secret", required: true },
      pickerApiKey: { env: "GOOGLE_PICKER_API_KEY", ssm: "google-picker-api-key", required: true },
      projectNumber: { env: "GOOGLE_PROJECT_NUMBER", ssm: "google-project-number" },
      publicUrl: { env: "TALON_PUBLIC_URL", ssm: "public-url" },
    },
  });
  const accounts = () => (store ??= createConnectionsStore({ provider: "google_drive", tokenPurpose: tokenPurposes.google_drive }));

  async function requireSettings() {
    const cfg = await loadSettings();
    if (!cfg) {
      throw httpError("Google Drive is not set up on this server", 503, "not-configured");
    }
    return cfg;
  }
  const redirectUri = (cfg) => `${String(cfg.publicUrl || "http://localhost:5173").replace(/\/+$/, "")}${callbackPath}`;

  // POST to Google's token endpoint (form encoded). Errors carry Google's
  // error code (invalid_grant: revoked or expired refresh token).
  async function tokenRequest(cfg, params) {
    const response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }).toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw httpError(`Google token request failed: ${data.error || response.status}`, 502, data.error || "token-failed");
    }
    return data;
  }

  const tokensFrom = (grant, previousRefresh = "") => ({
    accessToken: grant.access_token,
    // Google sends a refresh token on consent, not on refresh.
    refreshToken: grant.refresh_token || previousRefresh,
    scope: String(grant.scope || ""),
    accessExpiresAt: Number(grant.expires_in) > 0 ? new Date(now() + Number(grant.expires_in) * 1000) : null,
    refreshExpiresAt: Number(grant.refresh_token_expires_in) > 0 ? new Date(now() + Number(grant.refresh_token_expires_in) * 1000) : null,
  });

  // The user's access token, refreshed when about to expire; null when not
  // linked or the link is dead (then it is forgotten so Connect shows again).
  async function getAccessToken(userId) {
    const cfg = await loadSettings();
    if (!userId || !cfg) {
      return null;
    }
    const fresh = (t) => t.accessToken && (!t.accessExpiresAt || t.accessExpiresAt.getTime() - now() > refreshMarginMs);
    const current = await accounts().getTokens(userId);
    if (!current) {
      return null;
    }
    if (fresh(current)) {
      return current.accessToken;
    }
    let forget = false;
    const token = await accounts().withLockedTokens(userId, async (locked, save) => {
      if (!locked) {
        return null;
      }
      if (fresh(locked)) {
        return locked.accessToken;
      }
      if (!locked.refreshToken) {
        forget = true;
        return null;
      }
      try {
        const next = tokensFrom(await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: locked.refreshToken }), locked.refreshToken);
        await save(next);
        return next.accessToken;
      } catch (error) {
        // Revoked, expired (Testing-mode apps: 7 days) or the client changed:
        // connect again. Anything else (Google down) leaves the link alone.
        if (error.code === "invalid_grant" || error.code === "unauthorized_client") {
          forget = true;
          return null;
        }
        throw error;
      }
    });
    if (forget) {
      log.info("Google Drive link expired or was revoked; unlinking", { event: "google_drive.link_dead", userId });
      await accounts().deleteLink(userId);
    }
    return token;
  }

  async function requireAccessToken(userId) {
    await requireSettings();
    const token = await getAccessToken(userId);
    if (!token) {
      throw httpError("Connect Google Drive first", 409, "not-linked");
    }
    return token;
  }

  async function revoke(token) {
    if (!token) {
      return;
    }
    try {
      await fetchImpl(`${revokeUrl}?${new URLSearchParams({ token })}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    } catch (error) {
      log.warn("could not revoke the Google grant", { event: "google_drive.revoke_failed", error: error.message });
    }
  }

  // What the browser needs to open the Google Picker: the user's own
  // short-lived access token, the Picker API key and the
  // project number. GET /api/connections/google_drive/picker.
  async function pickerConfig(userId) {
    const cfg = await requireSettings();
    const accessToken = await requireAccessToken(userId);
    return { accessToken, apiKey: cfg.pickerApiKey, appId: pickerAppId(cfg) };
  }

  // A place inside something the user picked: the picked item (it must be
  // in their list, which is what limits Talon to what they chose), and for
  // a folder the subfolder at relPath. Returns { token, drive, root, folderId }
  // (root: { id, label, kind }; folderId null for a picked file).
  async function locate(userId, itemId, relPath = "") {
    const token = await requireAccessToken(userId);
    const root = (await accounts().listPicked(userId)).find((item) => item.id === String(itemId ?? ""));
    if (!root) {
      throw httpError("Choose this Drive item in Connections first", 403);
    }
    const folder = normalizeDrivePath(relPath);
    if (folder === null) {
      throw httpError("That is not a folder path inside the Drive folder (like week3 or ML 2026/cnn)", 400);
    }
    const drive = createDriveClient({ token, fetch: fetchImpl });
    if (root.kind !== "folder") {
      if (folder) {
        throw httpError("A single file has no folders inside it", 400);
      }
      return { token, drive, root, folderId: null };
    }
    return { token, drive, root, folderId: await drive.resolveFolder(root.id, folder) };
  }

  // One folder inside a picked folder, for the file browser:
  // { root, path, items: [{ name, type: dir | file, path, size, native }] }.
  async function browse(userId, itemId, relPath = "") {
    const { drive, root, folderId } = await locate(userId, itemId, relPath);
    const folder = normalizeDrivePath(relPath) ?? "";
    if (!folderId) {
      const file = await drive.getFile(root.id);
      return { root, path: "", items: [{ name: safeName(file.name), type: "file", path: safeName(file.name), size: Number(file.size || 0), native: isNativeGoogleFile(file.mimeType) }] };
    }
    // Folders a job never gets (.git, .venv, __pycache__...) are not shown.
    const children = (await drive.listChildren(folderId)).filter((file) => !(file.mimeType === folderMime && isSkippedFolder(file.name)));
    const items = children.map((file) => {
      const name = safeName(file.name);
      return {
        name,
        type: file.mimeType === folderMime ? "dir" : "file",
        path: folder ? `${folder}/${name}` : name,
        size: Number(file.size || 0),
        native: isNativeGoogleFile(file.mimeType),
      };
    });
    return { root, path: folder, items };
  }

  const provider = {
    id: "google_drive",
    label: "Google Drive",
    auth: "oauth",
    roles: ["code"],
    modes: ["authorize"],

    status: async () => ({ configured: Boolean(await loadSettings()) }),

    async getLink(userId) {
      const link = await accounts().getLink(userId);
      if (!link) {
        return null;
      }
      const cfg = await loadSettings();
      const tokens = await accounts().getTokens(userId);
      return {
        login: link.login,
        linkedAt: link.linkedAt,
        // Connect again when the link was made with another OAuth client
        // (e.g. the personal test project before the LCPS one) or without
        // the Drive permission Talon now asks for (drive.file links).
        needsReconnect: Boolean((cfg && link.clientId && link.clientId !== cfg.clientId) || (tokens && !hasDriveScope(tokens.scope))),
      };
    },

    // prompt=consent: Google only returns a refresh token on consent.
    // select_account: students often have a personal and a school account.
    async authorizeUrl(state) {
      const cfg = await requireSettings();
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri(cfg),
        response_type: "code",
        scope: scopes.join(" "),
        access_type: "offline",
        prompt: "consent select_account",
        include_granted_scopes: "true",
        state,
      });
      return `${authBase}?${params}`;
    },

    async completeCallback(userId, query) {
      const code = String(query.code ?? "");
      if (!code) {
        return "denied";
      }
      const cfg = await requireSettings();
      const tokens = tokensFrom(await tokenRequest(cfg, { code, grant_type: "authorization_code", redirect_uri: redirectUri(cfg) }));
      // Google lets people untick permissions on the consent screen.
      if (!hasDriveScope(tokens.scope)) {
        await revoke(tokens.refreshToken || tokens.accessToken);
        return "missing-scope";
      }
      const me = await fetchImpl(userInfoUrl, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
      const info = me.ok ? await me.json().catch(() => null) : null;
      if (!info?.sub) {
        throw httpError(`Could not read the Google account (${me.status})`, 502);
      }
      try {
        await accounts().saveLink(userId, { externalId: info.sub, login: info.email || info.sub, clientId: cfg.clientId, tokens });
      } catch (error) {
        // Do not revoke here: Google revokes per account and app, which
        // would also cut off the Talon user who holds this account.
        if (error instanceof ConnectionInUseError) {
          return "in-use";
        }
        throw error;
      }
      return "connected";
    },

    // What Talon may read: the items the student picked (connection_items).
    // [{ id, label, kind: folder | file | google-doc }]
    async listItems(userId) {
      await requireSettings();
      if (!(await accounts().getLink(userId))) {
        throw httpError("Connect Google Drive first", 409, "not-linked");
      }
      return (await accounts().listPicked(userId)).map((item) => ({ ...item, private: false }));
    },

    // Records what the student picked in the Picker. Each id is checked with
    // Drive using the student's own token (it must exist, not be trashed,
    // and be readable by them); names and kinds come from Drive, not the
    // browser. Returns the updated list.
    async addPickedItems(userId, ids) {
      const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
      if (!unique.length || unique.length > 50 || !unique.every((id) => driveIdPattern.test(id))) {
        throw httpError("Choose between 1 and 50 Drive items", 400);
      }
      const token = await requireAccessToken(userId);
      if ((await accounts().countPicked(userId)) + unique.length > maxPickedPerUser) {
        throw httpError(`Talon can keep at most ${maxPickedPerUser} Drive items per person. Remove some first.`, 400);
      }
      const items = [];
      for (const id of unique) {
        const params = new URLSearchParams({ fields: "id, name, mimeType, trashed", supportsAllDrives: "true" });
        const response = await fetchImpl(`${driveApi}/files/${encodeURIComponent(id)}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
        if (response.status === 401) {
          await accounts().deleteLink(userId);
          throw httpError("Google Drive access was revoked. Connect Google Drive again.", 409, "not-linked");
        }
        if (response.status === 404 || response.status === 403) {
          throw httpError("One of the chosen items cannot be read with your Google account", 400);
        }
        if (!response.ok) {
          throw httpError(`Could not check the chosen item with Google Drive (${response.status})`, 502);
        }
        const file = await response.json();
        if (file.trashed) {
          throw httpError(`"${file.name}" is in the trash`, 400);
        }
        items.push({ id: file.id, label: String(file.name || file.id).slice(0, 300), kind: kindOf(file.mimeType) });
      }
      await accounts().addPicked(userId, items);
      return provider.listItems(userId);
    },

    async removePickedItem(userId, itemId) {
      return accounts().removePicked(userId, String(itemId));
    },

    pickerConfig,
    locate,
    browse,

    extendRouter(router, { requireAuth }) {
      router.get("/picker", requireAuth, async (req, res) => {
        try {
          res.set("Cache-Control", "no-store");
          return res.json(await pickerConfig(req.user.id));
        } catch (error) {
          return res.status(error.status || 500).json({ message: error.status ? error.message : "Could not open the Google Picker" });
        }
      });
      // { ids: [driveId] } from the Picker -> { items }
      router.post("/items", requireAuth, async (req, res) => {
        try {
          return res.json({ items: await provider.addPickedItems(req.user.id, req.body?.ids) });
        } catch (error) {
          return res.status(error.status || 500).json({ message: error.status ? error.message : "Could not save the chosen items" });
        }
      });
      // ?item=<picked id>&path=week3/cnn
      router.get("/browse", requireAuth, async (req, res) => {
        try {
          return res.json(await browse(req.user.id, req.query.item, req.query.path));
        } catch (error) {
          return res.status(error.status || 500).json({ message: error.status ? error.message : "Could not read the Drive folder" });
        }
      });
      router.delete("/items/:itemId", requireAuth, async (req, res) => {
        const removed = await provider.removePickedItem(req.user.id, req.params.itemId);
        return removed ? res.json({ ok: true }) : res.status(404).json({ message: "Not in your list" });
      });
    },

    async unlink(userId) {
      const tokens = await accounts().getTokens(userId);
      await revoke(tokens?.refreshToken || tokens?.accessToken);
      await accounts().deleteLink(userId);
    },

    getAccessToken,
  };
  return provider;
}
