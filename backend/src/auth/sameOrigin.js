// Refuses state-changing /api requests that a browser says came from another
// site. The session cookie is SameSite=Lax, which still lets a page on a
// sibling host of the same site send it, and several POST routes (logout,
// job cancel, ...) need no body, so an empty text/plain form post is enough
// to trigger them. Browsers label every request, so:
//   - Sec-Fetch-Site present: only "same-origin" (our own pages) or "none"
//     (the user typed the URL) pass; "same-site" and "cross-site" do not.
//   - else (older browsers) a present Origin must be our own host (or the
//     origin of TALON_PUBLIC_URL).
//   - neither header: not a browser page (curl, scripts, tests): allowed.
// GET/HEAD/OPTIONS are never changed by the API, so they pass (the OAuth
// callbacks are GETs).
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

export function requireSameOrigin({ publicUrl = process.env.TALON_PUBLIC_URL } = {}) {
  const publicOrigin = originOf(String(publicUrl ?? "").trim());

  return (req, res, next) => {
    if (safeMethods.has(req.method)) {
      return next();
    }

    const fetchSite = req.get("sec-fetch-site");
    let ok;
    if (fetchSite !== undefined) {
      ok = fetchSite === "same-origin" || fetchSite === "none";
    } else {
      const origin = req.get("origin");
      if (origin === undefined) {
        ok = true;
      } else {
        // Host is what the browser used (nginx passes it through), without a
        // scheme, so compare against the Origin's host[:port].
        let originHost = "";
        try {
          originHost = new URL(origin).host;
        } catch {
          // "null" or garbage: not ours.
        }
        ok = (originHost !== "" && originHost === String(req.get("host") ?? "").toLowerCase()) ||
          (publicOrigin !== "" && origin === publicOrigin);
      }
    }

    if (!ok) {
      return res.status(403).json({ message: "Cross-site request refused" });
    }
    return next();
  };
}
