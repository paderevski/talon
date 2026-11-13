import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJobLogs } from "../api/client";
import { buildStages, isEc2Job, parseTalonLine } from "../utils/jobProgress";
import { isPageHidden, logPollDelayMs } from "../utils/polling";
import JobProgress from "./JobProgress";

const maxLines = 2000;

// The job's log, fetched in chunks by cursor. Keeps polling while the job is
// queued or running (every 2 s while lines arrive, slower while it is quiet,
// not at all while the tab is hidden: utils/polling.js), and reads once more
// after it ends so the last lines show.
// EC2 jobs also get a progress timeline built from the job record and the
// log's "[talon]" step lines (kept apart: the visible log is capped).
export default function JobLogsPanel({ id, job, live, onClose }) {
  const [lines, setLines] = useState([]);
  const [events, setEvents] = useState([]);
  const [lastOutput, setLastOutput] = useState("");
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);
  const cursorRef = useRef(0);
  const preRef = useRef(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    cursorRef.current = 0;
    setLines([]);
    setEvents([]);
    setLastOutput("");
    setMessage("");
    setLoaded(false);
  }, [job.id]);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let running = false; // a request is in flight
    let unchanged = 0; // polls in a row that brought no new lines

    const schedule = () => {
      clearTimeout(timer);
      timer = null;
      // A hidden tab stops here; onVisibilityChange polls when it comes back.
      if (cancelled || !live || isPageHidden()) {
        return;
      }
      timer = setTimeout(load, logPollDelayMs(unchanged));
    };

    const load = async () => {
      if (running) {
        return;
      }
      running = true;
      let changed = false;
      try {
        const page = await fetchJobLogs(job.id, cursorRef.current);
        if (cancelled) {
          return;
        }
        cursorRef.current = Number.isFinite(page.nextCursor) ? page.nextCursor : cursorRef.current;
        changed = Boolean(page.lines?.length);
        if (page.lines?.length) {
          setLines((previous) => [...previous, ...page.lines].slice(-maxLines));
          const refMs = Date.parse(job.executionRef?.launchedAt || job.executionRef?.submittedAt || "");
          const parsed = [];
          let output = "";
          for (const line of page.lines) {
            const event = parseTalonLine(line, refMs);
            if (event) {
              parsed.push(event);
            } else if (line.trim()) {
              output = line;
            }
          }
          if (parsed.length) {
            setEvents((previous) => [...previous, ...parsed]);
          }
          if (output) {
            setLastOutput(output);
          }
        }
        setMessage(page.noData ? page.message || "" : "");
      } catch (error) {
        if (!cancelled) {
          setMessage(error.message || "Unable to load logs");
        }
      } finally {
        running = false;
      }
      if (!cancelled) {
        setLoaded(true);
        unchanged = changed ? 0 : unchanged + 1; // errors count as quiet, so they back off too
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (cancelled || !live || isPageHidden() || running) {
        return;
      }
      clearTimeout(timer);
      unchanged = 0;
      load();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [job.id, live]);

  useEffect(() => {
    const pre = preRef.current;
    if (pre && stickToBottomRef.current) {
      pre.scrollTop = pre.scrollHeight;
    }
  }, [lines]);

  const onScroll = () => {
    const pre = preRef.current;
    if (pre) {
      stickToBottomRef.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    }
  };

  const progress = useMemo(
    () => (isEc2Job(job) ? buildStages({ job, events, lastOutput }) : null),
    [job, events, lastOutput],
  );

  let emptyText = "Loading...";
  if (loaded) {
    emptyText = message || (live ? "Waiting for output..." : "This job wrote no output.");
  }

  return (
    <div className="job-log-panel" id={id}>
      <div className="job-log-head">
        <span className="job-log-title">Logs: {job.name}{live ? " (live)" : ""}</span>
        <button className="btn btn-secondary btn-sm" type="button" onClick={onClose}>Close</button>
      </div>
      {/* EC2 jobs: progress beside the log; the progress sets the height and
          the log scrolls within it. */}
      <div className={progress ? "job-log-split" : undefined}>
        {progress ? <JobProgress stages={progress.stages} startedAt={progress.startedAt} live={live} /> : null}
        <div className="job-log-pane">
          <pre className="job-log-body" ref={preRef} onScroll={onScroll} aria-label={`Logs for ${job.name}`}>
            {lines.length ? lines.join("\n") : emptyText}
          </pre>
        </div>
      </div>
      {lines.length && message ? <div className="form-hint">{message}</div> : null}
    </div>
  );
}
