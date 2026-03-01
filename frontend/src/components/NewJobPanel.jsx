import { useEffect, useState } from "react";

function makeInitialForm(defaultRepo, defaultBranch) {
  return {
    name: "",
    repo: defaultRepo || "jane_smith/bert-nlp",
    branch: defaultBranch || "main",
    entryScript: "train.py",
    gpuMemory: "Auto (use available)",
    maxRuntime: "4 hours",
    s3DataSource: "",
    outputDestination: "Home Directory (~/$JOB_NAME/)",
    environmentVariables: ""
  };
}

export default function NewJobPanel({ onSubmit, defaultRepo, defaultBranch }) {
  const [form, setForm] = useState(makeInitialForm(defaultRepo, defaultBranch));
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      repo: defaultRepo || "jane_smith/bert-nlp",
      branch: defaultBranch || "main",
    }));
  }, [defaultRepo, defaultBranch]);

  const update = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");

    try {
      await onSubmit(form);
      setMessage("Job submitted to queue.");
      setForm((prev) => ({
        ...makeInitialForm(defaultRepo, defaultBranch),
        repo: prev.repo,
        branch: prev.branch,
      }));
    } catch {
      setMessage("Unable to submit job.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel" id="new-job">
      <div className="panel-head">
        <h2 className="panel-title">Submit New Job</h2>
      </div>
      <form className="new-job-grid" onSubmit={handleSubmit}>
        <div className="form-group">
          <label className="form-label">Job Name</label>
          <input className="form-input" value={form.name} onChange={update("name")} placeholder="e.g. finetune-bert-v3" />
        </div>
        <div className="form-group">
          <label className="form-label">Gitea Repository</label>
          <input className="form-input" value={form.repo} onChange={update("repo")} placeholder="https://github.com/owner/repo" />
          <span className="form-hint">Accepts full GitHub URL or owner/repo. Auto-populates file browser below.</span>
        </div>
        <div className="form-group">
          <label className="form-label">Branch</label>
          <input className="form-input" value={form.branch} onChange={update("branch")} />
        </div>
        <div className="form-group">
          <label className="form-label">Entry Script</label>
          <input className="form-input" value={form.entryScript} onChange={update("entryScript")} />
        </div>
        <div className="form-group">
          <label className="form-label">GPU Memory Limit</label>
          <select className="form-select" value={form.gpuMemory} onChange={update("gpuMemory")}>
            <option>Auto (use available)</option>
            <option>4 GB</option>
            <option>8 GB</option>
            <option>12 GB</option>
            <option>16 GB (full T4)</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Max Runtime</label>
          <select className="form-select" value={form.maxRuntime} onChange={update("maxRuntime")}>
            <option>1 hour</option>
            <option>2 hours</option>
            <option>4 hours</option>
            <option>8 hours</option>
          </select>
        </div>
        <div className="form-group full">
          <label className="form-label">Environment Variables</label>
          <textarea
            className="form-input form-textarea"
            value={form.environmentVariables}
            onChange={update("environmentVariables")}
            placeholder={"BATCH_SIZE=32\nLEARNING_RATE=0.001\nEPOCHS=50"}
          />
        </div>
        <div className="form-group full form-actions">
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? "Submitting..." : "Submit Job"}
          </button>
          <button className="btn btn-secondary" type="button">Save as Template</button>
          {message ? <span className="form-hint">{message}</span> : null}
        </div>
      </form>
    </section>
  );
}
