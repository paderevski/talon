import { useEffect, useRef, useState } from "react";
import { fetchJobLogs } from "../api/client";

const pollIntervalMs = 4000;
const maxLines = 2000;

// The job's log, fetched in chunks by cursor. Keeps polling while the job is
// queued or running, and reads once more after it ends so the last lines show.
export default function JobLogsPanel({ job, live, onClose }) {
  const [lines, setLines] = useState([]);
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);
  const cursorRef = useRef(0);
  const preRef = useRef(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    cursorRef.current = 0;
    setLines([]);
    setMessage("");
    setLoaded(false);
  }, [job.id]);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const load = async () => {
      try {
        const page = await fetchJobLogs(job.id, cursorRef.current);
        if (cancelled) {
          return;
        }
        cursorRef.current = Number.isFinite(page.nextCursor) ? page.nextCursor : cursorRef.current;
        if (page.lines?.length) {
          setLines((previous) => [...previous, ...page.lines].slice(-maxLines));
        }
        setMessage(page.noData ? page.message || "" : "");
      } catch (error) {
        if (!cancelled) {
          setMessage(error.message || "Unable to load logs");
        }
      }
      if (!cancelled) {
        setLoaded(true);
        if (live) {
          timer = setTimeout(load, pollIntervalMs);
        }
      }
    };

    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
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

  let emptyText = "Loading...";
  if (loaded) {
    emptyText = message || (live ? "Waiting for output..." : "This job wrote no output.");
  }

  return (
    <div className="job-log-panel">
      <div className="job-log-head">
        <span className="job-log-title">Logs: {job.name}{live ? " (live)" : ""}</span>
        <button className="btn btn-secondary btn-sm" type="button" onClick={onClose}>Close</button>
      </div>
      <pre className="job-log-body" ref={preRef} onScroll={onScroll} aria-label={`Logs for ${job.name}`}>
        {lines.length ? lines.join("\n") : emptyText}
      </pre>
      {lines.length && message ? <div className="form-hint">{message}</div> : null}
    </div>
  );
}
