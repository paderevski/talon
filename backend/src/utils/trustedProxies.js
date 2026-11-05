// The "trust proxy" list for Express, from TALON_TRUSTED_PROXIES: comma
// separated addresses, CIDR ranges or Express's names ("loopback",
// "uniquelocal", ...). Default "loopback": nginx (production) and the Vite
// proxy (dev) both connect from 127.0.0.1, so it is always included. Behind the load balancer,
// configure.sh adds the VPC range so the ALB's hop is skipped too and
// req.ip is the real client.
//
// Never trust a range real clients can come from: they could then choose
// their own req.ip by sending X-Forwarded-For.
export function trustedProxies(value = process.env.TALON_TRUSTED_PROXIES) {
  const entries = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.includes("loopback") ? entries : ["loopback", ...entries];
}
