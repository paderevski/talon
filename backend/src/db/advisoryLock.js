// Fixed ids for Postgres advisory locks, in one place so two features never
// pick the same number. migrate.js has its own (727274) for history's sake.
export const lockIds = {
  ec2Reconciler: 727275,
};

// Runs fn() only if this process can take the session-level advisory lock
// `lockId` right now; otherwise returns { skipped: true } without waiting.
// Used for work that every web server schedules but only one should do at a
// time (the EC2 reconciler). The lock lives on its own pooled connection for
// the duration of fn, so fn may use the pool freely; if that connection dies,
// Postgres drops the lock with it.
export async function withTryAdvisoryLock(pool, lockId, fn) {
  const client = await pool.connect();
  let locked = false;
  let broken = false;

  try {
    let result;
    try {
      result = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [lockId]);
    } catch (error) {
      broken = true; // a connection that failed a query is not reused
      throw error;
    }
    locked = result.rows[0]?.locked === true;
    if (!locked) {
      return { skipped: true };
    }
    return { skipped: false, result: await fn() };
  } finally {
    if (locked) {
      // A connection still holding the lock must never go back to the pool
      // (the next borrower would hold it forever): destroy it instead.
      await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {
        broken = true;
      });
    }
    client.release(broken);
  }
}
