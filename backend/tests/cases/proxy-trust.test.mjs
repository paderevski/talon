import express from "express";
import { assert } from "../lib/harness.mjs";
import { trustedProxies } from "../../src/utils/trustedProxies.js";

export const name = "proxy trust: req.ip and req.secure through nginx and the load balancer";

// A throwaway app with server.js's trust setting, called from loopback the
// way nginx calls the backend.
async function probe(setting, headers) {
  const app = express();
  app.set("trust proxy", setting);
  app.get("/", (req, res) => res.json({ ip: req.ip, secure: req.secure }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers });
    return await response.json();
  } finally {
    server.close();
  }
}

export async function run() {
  assert(JSON.stringify(trustedProxies(undefined)) === '["loopback"]', "default is loopback");
  assert(JSON.stringify(trustedProxies("10.20.0.0/16")) === '["loopback","10.20.0.0/16"]', "loopback always kept");
  assert(JSON.stringify(trustedProxies(" loopback , 10.20.0.0/16 ,")) === '["loopback","10.20.0.0/16"]', "list is trimmed");

  // Client -> ALB (10.20.1.5) -> nginx -> backend. The client also tries to
  // spoof an address in front.
  const viaAlb = { "X-Forwarded-For": "6.6.6.6, 203.0.113.9, 10.20.1.5", "X-Forwarded-Proto": "https" };

  const behindAlb = await probe(trustedProxies("10.20.0.0/16"), viaAlb);
  assert(behindAlb.ip === "203.0.113.9", `behind the ALB req.ip should be the client, got ${behindAlb.ip}`);
  assert(behindAlb.secure === true, "X-Forwarded-Proto https from nginx makes req.secure");

  const loopbackOnly = await probe(trustedProxies(undefined), viaAlb);
  assert(loopbackOnly.ip === "10.20.1.5", `with loopback only, the ALB hop is not skipped, got ${loopbackOnly.ip}`);

  // Through the SSM tunnel: nginx sees 127.0.0.1 and appends it.
  const tunnel = await probe(trustedProxies(undefined), { "X-Forwarded-For": "127.0.0.1", "X-Forwarded-Proto": "http" });
  assert(tunnel.ip === "127.0.0.1" && tunnel.secure === false, `tunnel: ${JSON.stringify(tunnel)}`);
}
