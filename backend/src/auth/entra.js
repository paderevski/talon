import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { createSettingsLoader } from "../connections/settings.js";
import { log } from "../utils/log.js";

// Sign in with Microsoft (Entra ID, the LCPS tenant): OpenID Connect
// authorization code flow with PKCE, as a confidential client (the client
// secret stays on the server). Only users of the configured tenant get in;
// IT decides which of them may (the app registration's user assignment).
//
//   GET /api/auth/entra/login     beginLogin: redirect to Microsoft
//   GET /api/auth/entra/callback  finishLogin: check state, exchange the code,
//                                 verify the ID token -> claims
// Matching the claims to a Talon user is services/entraSignIn.js.
//
// Settings, from the environment first (local dev: backend/.env), else SSM
// under TALON_SSM_PREFIX (production):
//   ENTRA_TENANT_ID      entra-tenant-id      (String, Terraform)
//   ENTRA_CLIENT_ID      entra-client-id      (String, Terraform)
//   ENTRA_CLIENT_SECRET  entra-client-secret  (SecureString, by hand)
//   ENTRA_AUTO_CREATE    entra-auto-create    (String, Terraform; "student"
//                        (default): a tenant user with no Talon account gets a
//                        student account; "off": refused)
//   ENTRA_EMAIL_DOMAINS  entra-email-domains  (String, Terraform; optional
//                        comma list, e.g. "lcps.org": email linking and new
//                        accounts only for these domains)
// The App Registration must add the optional ID token claims `email` and
// `xms_edov` (see verifiedEmailFromClaims).
//   TALON_PUBLIC_URL     public-url           (shared with GitHub and Google)
// Without the first three the login page shows no Microsoft button.
//
// Redirect URI: <public_url>/api/auth/entra/callback. A request that arrived
// on localhost (Vite dev server, the SSM tunnel) uses
// http://localhost:<port>/api/auth/entra/callback instead; Microsoft only
// accepts redirect URIs registered on the app, so each must be registered.

export const callbackPath = "/api/auth/entra/callback";
const microsoftAuthority = "https://login.microsoftonline.com";
const scope = "openid profile email";
const pendingMaxAgeMs = 10 * 60 * 1000;
const clockSkewMs = 5 * 60 * 1000;
const discoveryTtlMs = 60 * 60 * 1000;
const keyRefetchMinMs = 60 * 1000;
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A refused sign-in. code is what the login page turns into a message.
export class EntraLoginError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "EntraLoginError";
    this.code = code;
  }
}

const sha256url = (value) => createHash("sha256").update(value).digest("base64url");
const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

function sameSecret(got, want) {
  const a = Buffer.from(String(got ?? ""));
  const b = Buffer.from(String(want ?? ""));
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// The address Talon may match on or create an account with: the `email`
// claim, and only when Microsoft marks it verified (xms_edov: the address's
// domain is verified in the user's home tenant and the user is a member
// there, not a guest). Nothing else is trusted: preferred_username (the UPN)
// and an unverified email can be set to anyone's address by a tenant admin
// or a guest invitation. Also refused when the token names another identity
// provider (idp differs from iss: a guest or external account).
// Needs the optional ID token claims `email` and `xms_edov` on the App
// Registration (Token configuration); without them Microsoft sends no
// verified address and only already-linked users can sign in.
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isTrue = (value) => value === true || value === 1 || ["1", "true"].includes(String(value ?? "").toLowerCase());

export function verifiedEmailFromClaims(claims) {
  if (!isTrue(claims.xms_edov)) {
    return "";
  }
  if (claims.idp !== undefined && claims.idp !== claims.iss) {
    return "";
  }
  const text = String(claims.email ?? "").trim().toLowerCase();
  return emailPattern.test(text) && text.length <= 200 ? text : "";
}

// For logs only (who tried): whatever address the token carries, verified or not.
export function claimedEmailFromClaims(claims) {
  for (const value of [claims.email, claims.preferred_username]) {
    const text = String(value ?? "").trim().toLowerCase();
    if (text) {
      return text.slice(0, 200);
    }
  }
  return "";
}

export function parseDomains(value) {
  return String(value ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

export function createEntraClient({
  settings = null, // full settings object (tests); default: environment, then SSM
  env = process.env,
  ssm = null,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  // Tests point this at a fake Microsoft; production always uses the real one.
  const authority = env.NODE_ENV !== "production" && env.ENTRA_AUTHORITY_URL
    ? String(env.ENTRA_AUTHORITY_URL).replace(/\/+$/, "")
    : microsoftAuthority;

  const loadSettings = createSettingsLoader({
    name: "entra",
    env,
    ssm,
    config: settings,
    now,
    fields: {
      tenantId: { env: "ENTRA_TENANT_ID", ssm: "entra-tenant-id", required: true },
      clientId: { env: "ENTRA_CLIENT_ID", ssm: "entra-client-id", required: true },
      clientSecret: { env: "ENTRA_CLIENT_SECRET", ssm: "entra-client-secret", required: true },
      autoCreate: { env: "ENTRA_AUTO_CREATE", ssm: "entra-auto-create" },
      emailDomains: { env: "ENTRA_EMAIL_DOMAINS", ssm: "entra-email-domains" },
      publicUrl: { env: "TALON_PUBLIC_URL", ssm: "public-url" },
    },
  });

  async function requireSettings() {
    const cfg = await loadSettings();
    if (!cfg) {
      throw new EntraLoginError("not-configured", "Microsoft sign-in is not set up on this server");
    }
    const tenantId = String(cfg.tenantId).trim().toLowerCase();
    if (!guidPattern.test(tenantId)) {
      // A domain name would also work with Microsoft, but the token's tid is
      // always the GUID, and that is what is checked.
      throw new EntraLoginError("not-configured", "ENTRA_TENANT_ID must be the tenant ID (a GUID)");
    }
    return { ...cfg, tenantId };
  }

  // ---- Discovery and signing keys (cached) --------------------------------

  let discovery = null; // { doc, at, tenantId }
  let keys = null; // { list, at }

  async function getJson(url, what) {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new EntraLoginError("failed", `${what} request failed (${response.status})`);
    }
    return response.json();
  }

  async function getDiscovery(cfg) {
    if (discovery && discovery.tenantId === cfg.tenantId && now() - discovery.at < discoveryTtlMs) {
      return discovery.doc;
    }
    const doc = await getJson(`${authority}/${cfg.tenantId}/v2.0/.well-known/openid-configuration`, "OpenID discovery");
    const issuer = `${authority}/${cfg.tenantId}/v2.0`;
    if (doc.issuer !== issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new EntraLoginError("failed", `unexpected OpenID discovery document (issuer ${doc.issuer})`);
    }
    discovery = { doc, at: now(), tenantId: cfg.tenantId };
    keys = null;
    return doc;
  }

  // Microsoft rotates its signing keys; an unknown kid refetches them (at
  // most once a minute).
  async function signingKey(doc, kid) {
    const find = () => keys?.list.find((key) => key.kid === kid && key.kty === "RSA" && (!key.use || key.use === "sig"));
    const stale = !keys || now() - keys.at > discoveryTtlMs;
    let jwk = stale ? null : find();
    if (!jwk && (stale || now() - keys.at > keyRefetchMinMs)) {
      const body = await getJson(doc.jwks_uri, "Signing keys");
      keys = { list: Array.isArray(body.keys) ? body.keys : [], at: now() };
      jwk = find();
    }
    if (!jwk) {
      throw new EntraLoginError("failed", "ID token signed with an unknown key");
    }
    return createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  }

  // Checks the ID token Microsoft returned and returns its claims. The token
  // came straight from the token endpoint over TLS, but it is verified in
  // full anyway: signature, issuer, audience, tenant, times and nonce.
  async function verifyIdToken(idToken, { cfg, doc, nonce }) {
    const parts = String(idToken ?? "").split(".");
    const header = parts.length === 3 ? decodePart(parts[0]) : null;
    const claims = parts.length === 3 ? decodePart(parts[1]) : null;
    if (!header || !claims) {
      throw new EntraLoginError("failed", "malformed ID token");
    }
    if (header.alg !== "RS256" || !header.kid) {
      throw new EntraLoginError("failed", `unexpected ID token algorithm ${header.alg}`);
    }
    const key = await signingKey(doc, header.kid);
    const signed = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
    if (!signed) {
      throw new EntraLoginError("failed", "ID token signature is not valid");
    }

    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const nowSeconds = now() / 1000;
    const skew = clockSkewMs / 1000;
    const problems = [
      claims.iss !== doc.issuer && "issuer",
      !audience.includes(cfg.clientId) && "audience",
      String(claims.tid ?? "").toLowerCase() !== cfg.tenantId && "tenant",
      !(Number(claims.exp) > nowSeconds - skew) && "expired",
      claims.nbf !== undefined && !(Number(claims.nbf) <= nowSeconds + skew) && "not yet valid",
      !sameSecret(claims.nonce, nonce) && "nonce",
      !guidPattern.test(String(claims.oid ?? "").toLowerCase()) && "object id",
    ].filter(Boolean);
    if (problems.length) {
      throw new EntraLoginError("failed", `ID token refused: ${problems.join(", ")}`);
    }
    return claims;
  }

  function redirectUriFor(cfg, host) {
    const requestHost = String(host ?? "").trim().toLowerCase();
    if (/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(requestHost)) {
      return `http://${requestHost}${callbackPath}`;
    }
    return `${String(cfg.publicUrl || "http://localhost:5173").replace(/\/+$/, "")}${callbackPath}`;
  }

  return {
    callbackPath,

    status: async () => ({ configured: Boolean(await loadSettings()) }),

    // Returns { url, pending }: keep `pending` in the session and pass it to
    // finishLogin. host: the request's Host header (picks the redirect URI).
    async beginLogin({ host } = {}) {
      const cfg = await requireSettings();
      const doc = await getDiscovery(cfg);
      const pending = {
        state: randomToken(24),
        nonce: randomToken(24),
        verifier: randomToken(32),
        redirectUri: redirectUriFor(cfg, host),
        at: now(),
      };
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        response_type: "code",
        response_mode: "query", // a GET back to Talon, so the SameSite=Lax cookie is sent
        redirect_uri: pending.redirectUri,
        scope,
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: sha256url(pending.verifier),
        code_challenge_method: "S256",
        // Students often have more than one Microsoft account in the browser.
        prompt: "select_account",
      });
      return { url: `${doc.authorization_endpoint}?${params}`, pending };
    },

    // query: the callback's query string. Returns { oid, email (verified,
    // or ""), claimedEmail (logs only), name, policy: { autoCreate,
    // emailDomains } } or throws EntraLoginError.
    async finishLogin(pending, query = {}) {
      if (
        !pending || !sameSecret(query.state, pending.state)
        || !(now() - Number(pending.at) <= pendingMaxAgeMs)
      ) {
        throw new EntraLoginError("state", "sign-in state missing, wrong or expired");
      }
      if (query.error) {
        // access_denied: the user cancelled, or IT has not assigned them
        // to the app (AADSTS50105 is in error_description).
        const detail = String(query.error_description ?? "").split(/\r?\n/)[0].slice(0, 300);
        throw new EntraLoginError(
          /AADSTS50105/.test(detail) ? "not-assigned" : "denied",
          `Microsoft returned ${String(query.error).slice(0, 64)}: ${detail}`,
        );
      }
      const code = String(query.code ?? "");
      if (!code) {
        throw new EntraLoginError("denied", "no authorization code");
      }

      const cfg = await requireSettings();
      const doc = await getDiscovery(cfg);
      const response = await fetchImpl(doc.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: pending.redirectUri,
          code_verifier: pending.verifier,
          scope,
        }).toString(),
      });
      const grant = await response.json().catch(() => ({}));
      if (grant.error === "invalid_client") {
        // Wrong or expired client secret: re-read SSM next time, so a
        // corrected secret works without a restart.
        log.warn("Microsoft rejected the client secret; reloading settings next time", { event: "entra.invalid_client" });
        loadSettings.reset();
      }
      if (!response.ok || !grant.id_token) {
        const detail = String(grant.error_description ?? "").split(/\r?\n/)[0].slice(0, 300);
        throw new EntraLoginError("failed", `token request failed: ${grant.error || response.status} ${detail}`.trim());
      }

      const claims = await verifyIdToken(grant.id_token, { cfg, doc, nonce: pending.nonce });
      // Which claims the App Registration sends (names only, no values), and
      // the two the email check depends on: shows at a glance whether IT
      // added the optional claims `email` and `xms_edov`.
      log.info("Microsoft ID token received", {
        event: "auth.entra_claims",
        claims: Object.keys(claims).sort().join(","),
        hasEmail: Boolean(claims.email),
        xmsEdov: claims.xms_edov === undefined ? "missing" : String(claims.xms_edov),
        guest: claims.idp !== undefined && claims.idp !== claims.iss,
      });
      return {
        oid: String(claims.oid).toLowerCase(),
        email: verifiedEmailFromClaims(claims),
        claimedEmail: claimedEmailFromClaims(claims),
        name: String(claims.name ?? "").trim().slice(0, 200),
        policy: {
          autoCreate: String(cfg.autoCreate || "student").trim().toLowerCase() !== "off",
          emailDomains: parseDomains(cfg.emailDomains),
        },
      };
    },
  };
}
