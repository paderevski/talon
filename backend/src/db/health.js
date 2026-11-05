// Database check behind /api/health: the load balancer takes a server out of
// rotation when this fails, so it must answer quickly even when the database
// hangs instead of refusing (timeout covers both getting a connection and
// the query).
export async function checkDatabase(pool, { timeoutMs = 2_000 } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([pool.query("SELECT 1"), timeout]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}
