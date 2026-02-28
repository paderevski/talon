import { useEffect, useMemo, useState } from "react";
import { fetchJobs, fetchRepoTree, fetchResults, submitJob } from "./api/client";
import NewJobPanel from "./components/NewJobPanel";
import RepoBrowserPanel from "./components/RepoBrowserPanel";
import JobStatusPanel from "./components/JobStatusPanel";
import ResultsPanel from "./components/ResultsPanel";
import talonLogo from "../../assets/talon-logo.png";

const navSections = [
  { id: "new-job", label: "New Job" },
  { id: "repo-browser", label: "Repo Browser" },
  { id: "job-status", label: "Job Status" },
  { id: "results", label: "Results" }
];

const emptyRepo = { repository: "", branch: "main", lastCommit: "", items: [] };

export default function App() {
  const [repoPath, setRepoPath] = useState("jane_smith/bert-nlp");
  const [repoData, setRepoData] = useState(emptyRepo);
  const [jobs, setJobs] = useState([]);
  const [results, setResults] = useState([]);
  const [activeFilter, setActiveFilter] = useState("all");

  const load = async () => {
    const [repo, jobsData, resultData] = await Promise.all([
      fetchRepoTree(repoPath),
      fetchJobs(activeFilter),
      fetchResults()
    ]);

    setRepoData(repo);
    setJobs(jobsData.items || []);
    setResults(resultData.items || []);
  };

  useEffect(() => {
    load().catch(() => {
      setRepoData(emptyRepo);
      setJobs([]);
      setResults([]);
    });
  }, [repoPath, activeFilter]);

  const refreshJobs = async () => {
    const jobsData = await fetchJobs(activeFilter);
    setJobs(jobsData.items || []);
  };

  const onSubmitJob = async (form) => {
    await submitJob(form);
    if (form.repo && form.repo !== repoPath) {
      setRepoPath(form.repo);
    }
    await refreshJobs();
  };

  const statusCount = useMemo(() => jobs.length, [jobs]);

  return (
    <div className="app">
      <nav className="topbar">
        <div className="topbar-brand">Academies of Loudoun</div>
        <div className="topbar-right">
          <div className="server-pill">g4dn.xlarge · us-east-1</div>
          <div className="user-pill">
            <div className="user-avatar">JS</div>
            jane_smith
          </div>
        </div>
      </nav>

      <div className="layout">
        <nav className="leftnav">
          <div className="side-title">
            <img src={talonLogo} alt="Talon" className="side-logo" />
          </div>
          {navSections.map((section) => (
            <a key={section.id} href={`#${section.id}`} className="nav-item">
              {section.label}
              {section.id === "job-status" ? <span className="nav-count">{statusCount}</span> : null}
            </a>
          ))}
        </nav>

        <main className="main">
          <NewJobPanel onSubmit={onSubmitJob} />
          <RepoBrowserPanel repoData={repoData} />
          <JobStatusPanel jobs={jobs} activeFilter={activeFilter} setActiveFilter={setActiveFilter} />
          <ResultsPanel results={results} />
        </main>
      </div>
    </div>
  );
}
