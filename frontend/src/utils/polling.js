// Pacing for the live views that poll the API.
//
// The job log panel asks for new lines every 2 seconds while a job is live.
// Most of those replies are "nothing new" (304), and each one costs the server
// a database lookup and an S3 read, so the wait grows while a job is quiet and
// snaps back to 2 seconds as soon as lines arrive. A hidden browser tab stops
// polling altogether and polls once when it becomes visible again.

const logPollSteps = [
  { from: 0, ms: 2000 }, // lines are arriving, or just stopped
  { from: 5, ms: 5000 }, // five quiet polls in a row (about 10 s)
  { from: 10, ms: 10000 }, // ten quiet polls in a row (about 35 s)
];

// unchangedPolls: how many polls in a row brought no new lines.
export function logPollDelayMs(unchangedPolls) {
  const quiet = Number.isFinite(unchangedPolls) ? Math.max(0, unchangedPolls) : 0;
  let ms = logPollSteps[0].ms;
  for (const step of logPollSteps) {
    if (quiet >= step.from) {
      ms = step.ms;
    }
  }
  return ms;
}

// True while the tab is in the background (or the window is minimised).
export function isPageHidden() {
  return typeof document !== "undefined" && document.hidden === true;
}
