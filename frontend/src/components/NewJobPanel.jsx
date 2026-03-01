import { useEffect, useState } from "react";
import { fetchGithubPublicRepos, fetchRepoTree } from "../api/client";
import { normalizeRepoInput } from "../utils/repo";

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

export default function NewJobPanel({ onSubmit, defaultRepo, defaultBranch, githubUsername }) {
  const [form, setForm] = useState(makeInitialForm(defaultRepo, defaultBranch));
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [repoOptions, setRepoOptions] = useState([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [repoError, setRepoError] = useState("");
  const [scriptOptions, setScriptOptions] = useState([]);
  const [isLoadingScripts, setIsLoadingScripts] = useState(false);
  const [scriptError, setScriptError] = useState("");
  const canUseRepoDropdown = githubUsername && !repoError && repoOptions.length > 0;

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

  useEffect(() => {
    const normalizedUsername = String(githubUsername ?? "").trim();

    if (!normalizedUsername) {
      setRepoOptions([]);
      setIsLoadingRepos(false);
      setRepoError("");
      return;
    }

    let cancelled = false;
    setIsLoadingRepos(true);
    setRepoError("");

    fetchGithubPublicRepos(normalizedUsername)
      .then((repos) => {
        if (cancelled) {
          return;
        }

        setRepoOptions(repos);
        setForm((prev) => {
          const normalizedCurrentRepo = normalizeRepoInput(prev.repo);
          if (!repos.length || (normalizedCurrentRepo && repos.includes(normalizedCurrentRepo))) {
            return prev;
          }

          return {
            ...prev,
            repo: repos[0],
          };
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setRepoOptions([]);
        setRepoError(error.message || "Unable to load repositories");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingRepos(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [githubUsername]);

  useEffect(() => {
    const normalizedRepo = normalizeRepoInput(form.repo);
    const branch = String(form.branch ?? "").trim() || "main";

    if (!normalizedRepo) {
      setScriptOptions([]);
      setIsLoadingScripts(false);
      setScriptError("");
      return;
    }

    let cancelled = false;
    setIsLoadingScripts(true);
    setScriptError("");

    fetchRepoTree(normalizedRepo, branch)
      .then((repoData) => {
        if (cancelled) {
          return;
        }

        const pythonFiles = (repoData.items || [])
          .filter((item) => item?.type === "file")
          .map((item) => String(item.path || item.rawName || item.name || "").trim())
          .filter((filePath) => filePath && !filePath.includes("/") && filePath.toLowerCase().endsWith(".py"));

        setScriptOptions(pythonFiles);
        setForm((prev) => {
          if (!pythonFiles.length || (prev.entryScript && pythonFiles.includes(prev.entryScript))) {
            return prev;
          }

          return {
            ...prev,
            entryScript: pythonFiles[0],
          };
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setScriptOptions([]);
        setScriptError(error.message || "Unable to load Python scripts");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingScripts(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [form.repo, form.branch]);

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
          <label className="form-label">Repository</label>
          {canUseRepoDropdown ? (
            <select className="form-select" value={normalizeRepoInput(form.repo)} onChange={update("repo")} disabled={isLoadingRepos || !repoOptions.length}>
              {isLoadingRepos ? <option>Loading repositories...</option> : null}
              {!isLoadingRepos && !repoOptions.length ? <option>No public repositories found</option> : null}
              {repoOptions.map((repo) => (
                <option key={repo} value={repo}>{repo}</option>
              ))}
            </select>
          ) : (
            <input className="form-input" value={form.repo} onChange={update("repo")} placeholder="https://github.com/owner/repo" />
          )}
          <span className="form-hint">
            {repoError
              ? `${repoError}. You can paste a repo URL manually.`
              : (canUseRepoDropdown ? "Using public repositories for configured GitHub username." : "Accepts full GitHub URL or owner/repo.")}
          </span>
        </div>
        <div className="form-group">
          <label className="form-label">Branch</label>
          <input className="form-input" value={form.branch} onChange={update("branch")} />
        </div>
        <div className="form-group">
          <label className="form-label">Entry Script</label>
          {scriptOptions.length ? (
            <select className="form-select" value={form.entryScript} onChange={update("entryScript")} disabled={isLoadingScripts}>
              {scriptOptions.map((script) => (
                <option key={script} value={script}>{script}</option>
              ))}
            </select>
          ) : (
            <input className="form-input" value={form.entryScript} onChange={update("entryScript")} placeholder="train.py" />
          )}
          <span className="form-hint">
            {scriptError
              ? scriptError
              : (isLoadingScripts
                ? "Loading top-level Python files..."
                : (scriptOptions.length
                  ? "Select any top-level .py file from this repo and branch."
                  : "No top-level .py files found on this branch. You can enter one manually."))}
          </span>
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
