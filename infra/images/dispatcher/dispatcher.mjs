function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  // Placeholder control-loop process until real SQS dispatch logic is wired.
  for (;;) {
    // eslint-disable-next-line no-console
    console.log(`[${new Date().toISOString()}] talon-dispatcher heartbeat`);
    await sleep(15000);
  }
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
