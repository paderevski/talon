import { execFile } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { assert, createCookieJar, login, startBackendForTests, testDatabaseUrl, withTestDb } from "../lib/harness.mjs";

export const name = "Microsoft (Entra) sign-in: off unless configured; links students by verified email only, staff by admin; creates students, checks state, PKCE and the ID token";

const tenant = "11111111-2222-3333-4444-555555555555";
const clientId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const domain = "school.test";
const oid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const sha256url = (value) => createHash("sha256").update(value).digest("base64url");
const b64json = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function makeJwt(claims, privateKey, header = {}) {
  const head = b64json({ alg: "RS256", kid: "k1", typ: "JWT", ...header });
  const body = b64json(claims);
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

// A fake login.microsoftonline.com: discovery, signing keys and the token
// endpoint. The test registers each authorization code with the claims its
// ID token should carry.
async function startFakeMicrosoft() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" };
  const fake = { codes: new Map(), secret: "test-client-secret", privateKey, tokenRequests: 0 };

  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, fake.base);
    if (req.method === "GET" && url.pathname === `/${tenant}/v2.0/.well-known/openid-configuration`) {
      return send(200, {
        issuer: `${fake.base}/${tenant}/v2.0`,
        authorization_endpoint: `${fake.base}/${tenant}/oauth2/v2.0/authorize`,
        token_endpoint: `${fake.base}/${tenant}/oauth2/v2.0/token`,
        jwks_uri: `${fake.base}/${tenant}/discovery/v2.0/keys`,
      });
    }
    if (req.method === "GET" && url.pathname === `/${tenant}/discovery/v2.0/keys`) {
      return send(200, { keys: [jwk] });
    }
    if (req.method === "POST" && url.pathname === `/${tenant}/oauth2/v2.0/token`) {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        fake.tokenRequests += 1;
        const form = new URLSearchParams(raw);
        if (form.get("client_id") !== clientId || form.get("client_secret") !== fake.secret) {
          return send(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
        }
        const entry = fake.codes.get(form.get("code"));
        fake.codes.delete(form.get("code"));
        if (
          !entry || form.get("grant_type") !== "authorization_code"
          || sha256url(form.get("code_verifier") || "") !== entry.challenge
          || form.get("redirect_uri") !== entry.redirectUri
        ) {
          return send(400, { error: "invalid_grant" });
        }
        return send(200, { token_type: "Bearer", id_token: entry.idToken, access_token: "unused" });
      });
      return undefined;
    }
    return send(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.base = `http://127.0.0.1:${server.address().port}`;
  fake.stop = () => new Promise((resolve) => server.close(resolve));
  return fake;
}

// One full round trip in a fresh browser (cookie jar). claims: added to (or,
// as a function, replacing) the valid ID token claims. Returns where the
// callback sent the browser and the jar, signed in or not.
async function microsoftSignIn(baseUrl, fake, claims = {}, { key = fake.privateKey, header = {}, query = null } = {}) {
  const jar = createCookieJar();
  const start = await jar.fetch(`${baseUrl}/api/auth/entra/login`, { redirect: "manual" });
  assert(start.status === 303, `login start: expected 303, got ${start.status}`);
  const authorize = new URL(start.headers.get("location"));
  const params = authorize.searchParams;
  assert(authorize.origin === fake.base && authorize.pathname === `/${tenant}/oauth2/v2.0/authorize`, `authorize URL ${authorize}`);
  assert(params.get("client_id") === clientId && params.get("response_type") === "code" && params.get("response_mode") === "query", `authorize params ${params}`);
  assert(params.get("code_challenge_method") === "S256" && params.get("code_challenge") && params.get("nonce") && params.get("state"), "PKCE, nonce and state are sent");
  assert(params.get("redirect_uri") === `${baseUrl}/api/auth/entra/callback`, `redirect_uri ${params.get("redirect_uri")}`);
  assert(params.get("scope") === "openid profile email", `scope ${params.get("scope")}`);
  const cookieBefore = jar.get("talon.sid");

  const now = Math.floor(Date.now() / 1000);
  const valid = {
    iss: `${fake.base}/${tenant}/v2.0`, aud: clientId, tid: tenant, iat: now, nbf: now, exp: now + 3600,
    nonce: params.get("nonce"), oid: oid(1), name: "Someone", preferred_username: `someone@${domain}`,
    email: `someone@${domain}`, xms_edov: true,
  };
  const code = randomBytes(12).toString("hex");
  fake.codes.set(code, {
    challenge: params.get("code_challenge"),
    redirectUri: params.get("redirect_uri"),
    idToken: makeJwt(typeof claims === "function" ? claims(valid) : { ...valid, ...claims }, key, header),
  });
  const callbackQuery = query ? query({ code, state: params.get("state") }) : { code, state: params.get("state") };
  const callbackUrl = `${baseUrl}/api/auth/entra/callback?${new URLSearchParams(callbackQuery)}`;
  const callback = await jar.fetch(callbackUrl, { redirect: "manual" });
  assert(callback.status === 303, `callback: expected 303, got ${callback.status}`);
  return { location: callback.headers.get("location"), jar, cookieBefore, callbackUrl };
}

async function me(jar, baseUrl) {
  const response = await jar.fetch(`${baseUrl}/api/auth/me`);
  return response.ok ? (await response.json()).user : null;
}

async function expectRefused(baseUrl, fake, code, claims, options) {
  const result = await microsoftSignIn(baseUrl, fake, claims, options);
  assert(result.location === `/?signin=${code}`, `expected signin=${code}, went to ${result.location}`);
  assert((await me(result.jar, baseUrl)) === null, `refused sign-in (${code}) must not leave a session`);
  return result;
}

const testUsers = `lower(username) LIKE '%@${domain}' OR lower(email) LIKE '%@${domain}' OR username LIKE 'entra.%'`;

// The admin's link script (scripts/db-link-entra.mjs) against the test database.
const linkScript = fileURLToPath(new URL("../../scripts/db-link-entra.mjs", import.meta.url));
async function linkEntra(...args) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [linkScript, ...args], {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    });
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout}${error.stderr}` };
  }
}

async function cleanUp() {
  await withTestDb((pool) => pool.query(`DELETE FROM users WHERE ${testUsers}`));
}

export async function run({ baseUrl }) {
  // Not configured (the shared test server): no button, and the login
  // route says so instead of failing.
  const options = await (await fetch(`${baseUrl}/api/auth/options`)).json();
  assert(options.entra === false, `options without settings: ${JSON.stringify(options)}`);
  const off = await fetch(`${baseUrl}/api/auth/entra/login`, { redirect: "manual" });
  assert(off.status === 303 && off.headers.get("location") === "/?signin=not-configured", `unconfigured login went to ${off.headers.get("location")}`);
  const offCallback = await fetch(`${baseUrl}/api/auth/entra/callback?code=x&state=y`, { redirect: "manual" });
  assert(offCallback.headers.get("location") === "/?signin=state", `unconfigured callback went to ${offCallback.headers.get("location")}`);

  // Password users have localSignIn (they get the Change password menu).
  const jane = createCookieJar();
  await login(jane, baseUrl, "jane_smith", "talon123");
  assert((await me(jane, baseUrl))?.localSignIn === true, "password users have localSignIn");

  const fake = await startFakeMicrosoft();
  const entraEnv = {
    ENTRA_TENANT_ID: tenant.toUpperCase(), // GUIDs compare case-insensitively
    ENTRA_CLIENT_ID: clientId,
    ENTRA_CLIENT_SECRET: fake.secret,
    ENTRA_AUTHORITY_URL: fake.base,
    ENTRA_EMAIL_DOMAINS: `${domain}, @other.test`,
  };
  const server = await startBackendForTests({ reset: false, env: entraEnv });
  let strict = null;

  try {
    await cleanUp();
    await withTestDb(async (pool) => {
      const add = async (username, email, role, status = "active") => {
        const { rows } = await pool.query(
          "INSERT INTO users (username, email, display_name, status) VALUES ($1, $2, $1, $3) RETURNING id",
          [username, email, status],
        );
        await pool.query("INSERT INTO user_roles (user_id, role) VALUES ($1, $2)", [rows[0].id, role]);
      };
      await add("entra.teacher", `Teacher.One@${domain.toUpperCase()}`, "teacher"); // made by an admin
      await add("entra.admin", `boss@${domain}`, "admin");
      await add("entra.both", `both@${domain}`, "student");
      await pool.query("INSERT INTO user_roles (user_id, role) SELECT id, 'teacher' FROM users WHERE username = 'entra.both'");
      await pool.query("INSERT INTO users (username, email, display_name) VALUES ('entra.norole', $1, 'No Role')", [`norole@${domain}`]);
      await add("entra.student", `Student.One@${domain}`, "student");
      await add(`byname@${domain}`, null, "student"); // imported with the email as username
      await add("dup.one", `dup@${domain}`, "student");
      await add(`dup@${domain}`, null, "student");
      await add("gone.student", `gone@${domain}`, "student", "disabled");
    });

    const base = server.baseUrl;
    assert((await (await fetch(`${base}/api/auth/options`)).json()).entra === true, "options with settings");

    // Only an address Microsoft marks verified is trusted: not the UPN, not
    // an unverified email, not a guest's.
    await expectRefused(base, fake, "no-email", { oid: oid(20), email: undefined, preferred_username: `student.one@${domain}` });
    await expectRefused(base, fake, "no-email", { oid: oid(20), email: `student.one@${domain}`, xms_edov: undefined });
    await expectRefused(base, fake, "no-email", { oid: oid(20), email: `student.one@${domain}`, xms_edov: false });
    await expectRefused(base, fake, "no-email", { oid: oid(20), email: `student.one@${domain}`, xms_edov: "0" });
    await expectRefused(base, fake, "no-email", { oid: oid(20), email: `student.one@${domain}`, idp: "https://sts.windows.net/99999999-0000-0000-0000-000000000000/" });
    const unlinked = await withTestDb((pool) => pool.query("SELECT count(*)::int AS n FROM user_identities WHERE subject = $1", [oid(20)]));
    assert(unlinked.rows[0].n === 0, "no link from an unverified address");

    // First sign-in of a student an admin created: linked by verified email
    // (any case, xms_edov as a string too), new session id.
    const student = await microsoftSignIn(base, fake, { oid: oid(20), email: `student.one@${domain}`, xms_edov: "1", name: "Student One" });
    assert(student.location === "/", `student sign-in went to ${student.location}`);
    const studentMe = await me(student.jar, base);
    assert(studentMe?.username === "entra.student" && studentMe.roles.length === 1, `student /me ${JSON.stringify(studentMe)}`);
    assert(student.jar.get("talon.sid") !== student.cookieBefore, "sign-in must issue a new session id");

    // Anyone who is not a plain student is never linked automatically.
    await expectRefused(base, fake, "link-by-admin", { oid: oid(1), email: `teacher.one@${domain}` });
    await expectRefused(base, fake, "link-by-admin", { oid: oid(21), email: `boss@${domain}` });
    await expectRefused(base, fake, "link-by-admin", { oid: oid(22), email: `both@${domain}` });
    await expectRefused(base, fake, "link-by-admin", { oid: oid(23), email: `norole@${domain}` });
    const staffLinks = await withTestDb((pool) => pool.query(
      "SELECT count(*)::int AS n FROM user_identities WHERE subject = ANY($1)", [[oid(1), oid(21), oid(22), oid(23)]],
    ));
    assert(staffLinks.rows[0].n === 0, "no staff account linked automatically");

    // An admin links the teacher with the script; then Microsoft sign-in
    // works and keeps their roles.
    const bad = await linkEntra("--username", "entra.teacher", "--oid", "not-a-guid");
    assert(!bad.ok, "link script refuses a non-GUID object id");
    const taken = await linkEntra("--username", "entra.teacher", "--oid", oid(20));
    assert(!taken.ok && /already linked to 'entra.student'/.test(taken.output), `link script refuses a used object id: ${taken.output}`);
    const linked = await linkEntra("--username", "entra.teacher", "--oid", oid(1).toUpperCase());
    assert(linked.ok && /Linked Microsoft account/.test(linked.output), `link script: ${linked.output}`);
    const twice = await linkEntra("--username", "entra.teacher", "--oid", oid(24));
    assert(!twice.ok && /--unlink first/.test(twice.output), `link script refuses a second Microsoft account: ${twice.output}`);
    const first = await microsoftSignIn(base, fake, { oid: oid(1), email: undefined, xms_edov: undefined, name: "Teacher One" });
    assert(first.location === "/", `teacher sign-in went to ${first.location}`);
    const teacher = await me(first.jar, base);
    assert(teacher?.username === "entra.teacher" && teacher.roles.includes("teacher"), `teacher /me ${JSON.stringify(teacher)}`);
    assert(teacher.localSignIn === false, "a Microsoft-only user has no Talon password");

    // Later sign-ins go by the Microsoft object id, whatever the email says.
    const renamed = await microsoftSignIn(base, fake, { oid: oid(1), email: `renamed@${domain}` });
    assert((await me(renamed.jar, base))?.username === "entra.teacher", "linked account found by object id");

    // Another Microsoft account with that email does not take the user over.
    await expectRefused(base, fake, "already-linked", { oid: oid(2), email: `teacher.one@${domain}` });

    // Unlinking stops Microsoft sign-in for that account.
    const unlinkedTeacher = await linkEntra("--username", "entra.teacher", "--unlink");
    assert(unlinkedTeacher.ok && /Unlinked/.test(unlinkedTeacher.output), `unlink: ${unlinkedTeacher.output}`);
    await expectRefused(base, fake, "link-by-admin", { oid: oid(1), email: `teacher.one@${domain}` });
    assert((await linkEntra("--username", "entra.teacher", "--oid", oid(1))).ok, "relink");

    // Matched by username: linked, and the address recorded as its email.
    const byName = await microsoftSignIn(base, fake, { oid: oid(3), email: `ByName@${domain}`, preferred_username: "ignored" });
    assert((await me(byName.jar, base))?.username === `byname@${domain}`, "linked by username");
    const recorded = await withTestDb((pool) => pool.query("SELECT email FROM users WHERE username = $1", [`byname@${domain}`]));
    assert(recorded.rows[0].email === `byname@${domain}`, `email recorded: ${recorded.rows[0].email}`);

    // Nobody matches: a new student account named after Microsoft's name.
    const created = await microsoftSignIn(base, fake, { oid: oid(4), email: `newkid@${domain}`, preferred_username: undefined, name: "New Kid" });
    assert(created.location === "/", `new student went to ${created.location}`);
    const kid = await me(created.jar, base);
    assert(kid?.username === `newkid@${domain}` && kid.fullName === "New Kid" && kid.role === "student" && kid.roles.length === 1, `new student ${JSON.stringify(kid)}`);
    assert(kid.localSignIn === false, "new student has no password");
    const again = await microsoftSignIn(base, fake, { oid: oid(4), email: `newkid@${domain}` });
    assert((await me(again.jar, base))?.id === kid.id, "second sign-in is the same user");
    const counts = await withTestDb((pool) => pool.query(
      `SELECT (SELECT count(*) FROM users WHERE username = $1)::int AS users,
              (SELECT count(*) FROM budget_accounts a JOIN users u ON u.id = a.owner_user_id WHERE u.username = $1 AND a.kind = 'personal')::int AS accounts,
              (SELECT count(*) FROM user_identities i JOIN users u ON u.id = i.user_id WHERE u.username = $1)::int AS identities`,
      [`newkid@${domain}`],
    ));
    assert(JSON.stringify(counts.rows[0]) === JSON.stringify({ users: 1, accounts: 1, identities: 1 }), `new student rows ${JSON.stringify(counts.rows[0])}`);

    // Refused by policy or data.
    await expectRefused(base, fake, "ambiguous", { oid: oid(5), email: `dup@${domain}` });
    await expectRefused(base, fake, "disabled", { oid: oid(6), email: `gone@${domain}` });
    await expectRefused(base, fake, "domain", { oid: oid(7), email: "outsider@elsewhere.test" });
    await expectRefused(base, fake, "no-email", { oid: oid(8), email: "not-an-email" });
    const otherDomain = await microsoftSignIn(base, fake, { oid: oid(9), email: "someone@other.test" });
    assert(otherDomain.location === "/", "second allowed domain (written as @other.test)");

    // The ID token is checked in full.
    await expectRefused(base, fake, "failed", { oid: oid(10), nonce: "wrong" });
    await expectRefused(base, fake, "failed", { oid: oid(10), aud: "another-app" });
    await expectRefused(base, fake, "failed", { oid: oid(10), tid: "99999999-2222-3333-4444-555555555555" });
    await expectRefused(base, fake, "failed", { oid: oid(10), iss: "https://login.microsoftonline.com/common/v2.0" });
    await expectRefused(base, fake, "failed", { oid: oid(10), exp: Math.floor(Date.now() / 1000) - 3600 });
    await expectRefused(base, fake, "failed", { oid: oid(10), nbf: Math.floor(Date.now() / 1000) + 3600 });
    await expectRefused(base, fake, "failed", { oid: "not-a-guid" });
    await expectRefused(base, fake, "failed", (valid) => ({ ...valid, nonce: undefined }));
    const { privateKey: stranger } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expectRefused(base, fake, "failed", { oid: oid(10) }, { key: stranger });
    await expectRefused(base, fake, "failed", { oid: oid(10) }, { header: { kid: "unknown" } });
    await expectRefused(base, fake, "failed", { oid: oid(10) }, { header: { alg: "HS256" } });
    const created10 = await withTestDb((pool) => pool.query("SELECT count(*)::int AS n FROM user_identities WHERE subject = $1", [oid(10)]));
    assert(created10.rows[0].n === 0, "no account from a refused token");

    // State: wrong, missing, or used twice.
    await expectRefused(base, fake, "state", {}, { query: ({ code }) => ({ code, state: "guess" }) });
    await expectRefused(base, fake, "state", {}, { query: ({ code }) => ({ code }) });
    const used = await microsoftSignIn(base, fake, { oid: oid(4), email: `newkid@${domain}` });
    const replay = await used.jar.fetch(used.callbackUrl, { redirect: "manual" });
    assert(replay.headers.get("location") === "/?signin=state", `replayed callback went to ${replay.headers.get("location")}`);

    // Microsoft said no: cancelled, or not assigned to the app by IT.
    await expectRefused(base, fake, "denied", {}, { query: ({ state }) => ({ state, error: "access_denied", error_description: "The user cancelled." }) });
    await expectRefused(base, fake, "not-assigned", {}, {
      query: ({ state }) => ({ state, error: "access_denied", error_description: "AADSTS50105: The signed in user is not assigned to a role for the application." }),
    });

    // A wrong client secret: refused, and the server keeps working once fixed.
    fake.secret = "rotated";
    await expectRefused(base, fake, "failed", { oid: oid(4), email: `newkid@${domain}` });
    fake.secret = entraEnv.ENTRA_CLIENT_SECRET;
    assert((await microsoftSignIn(base, fake, { oid: oid(4) })).location === "/", "works again with the right secret");

    // Disabling a linked user stops Microsoft sign-in too.
    await withTestDb((pool) => pool.query("UPDATE users SET status = 'disabled' WHERE username = $1", [`newkid@${domain}`]));
    await expectRefused(base, fake, "disabled", { oid: oid(4) });

    // Auto-create off: only existing users get in.
    strict = await startBackendForTests({ reset: false, env: { ...entraEnv, ENTRA_AUTO_CREATE: "off" } });
    await expectRefused(strict.baseUrl, fake, "no-account", { oid: oid(11), email: `stranger@${domain}` });
    const existing = await microsoftSignIn(strict.baseUrl, fake, { oid: oid(1) });
    assert((await me(existing.jar, strict.baseUrl))?.username === "entra.teacher", "linked users still sign in with auto-create off");
  } finally {
    await strict?.stop();
    await server.stop();
    await fake.stop();
    await cleanUp();
  }
}
