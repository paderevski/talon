import { useEffect, useState } from "react";
import { fetchAdminRoster } from "../api/client";
import { formatClassName, formatDollars } from "../utils/format";

const emptyRoster = {
  stats: {
    userCount: 0,
    teacherCount: 0,
    studentCount: 0,
    adminCount: 0,
    classCount: 0,
  },
  admins: [],
  teachers: [],
  classes: [],
};

export default function AdminRosterPanel({ authUser, refreshKey = 0 }) {
  const [roster, setRoster] = useState(emptyRoster);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!authUser?.username) {
      setRoster(emptyRoster);
      setIsLoading(false);
      setError("");
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError("");

    fetchAdminRoster()
      .then((response) => {
        if (cancelled) {
          return;
        }

        setRoster(response?.roster || emptyRoster);
      })
      .catch((nextError) => {
        if (cancelled) {
          return;
        }

        setRoster(emptyRoster);
        setError(nextError.message || "Unable to load admin roster");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authUser, refreshKey]);

  return (
    <section className="panel" id="admin-roster">
      <div className="panel-head">
        <h2 className="panel-title">Overview</h2>
      </div>

      {error ? <div className="repo-error">{error}</div> : null}
      {isLoading ? <div className="form-hint">Loading roster...</div> : null}

      {!isLoading ? (
        <>
          <div className="results-grid stat-row">
            {[
              { label: "Users", count: roster.stats.userCount, href: "#users" },
              { label: "Teachers", count: roster.stats.teacherCount, href: "#users/teachers" },
              { label: "Students", count: roster.stats.studentCount, href: "#users/students" },
              { label: "Admins", count: roster.stats.adminCount, href: "#users/admins" },
              { label: "Classes", count: roster.stats.classCount, href: "#classes" },
            ].map((stat) => (
              <a key={stat.label} className="result-card stat-card-link" href={stat.href}>
                <div className="result-job-name">{stat.label}</div>
                <div className="result-meta-value mono-sm">{stat.count}</div>
              </a>
            ))}
          </div>

          <div className="panel-head subhead">
            <h3 className="panel-title">Student budgets by class</h3>
          </div>
          <div className="results-grid">
            {roster.classes.map((classItem) => (
              <article key={classItem.id} className="result-card">
                <div className="result-card-head">
                  <div className="result-job-name">{formatClassName(classItem.className, classItem.block)}</div>
                  <span className="status-pill queued">
                    <span className="sdot" />
                    {classItem.students.length} student{classItem.students.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="form-hint">Teacher: {classItem.teacherFullName}</div>
                <div className="form-hint mono-sm">{classItem.teacherUsername}</div>
                <table>
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Allocated</th>
                      <th>Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    {classItem.students.map((student) => (
                      <tr key={student.username}>
                        <td>
                          {student.fullName}
                          <div className="form-hint mono-sm">{student.username}</div>
                        </td>
                        <td>{formatDollars(student.quota)}</td>
                        <td>{formatDollars(student.tokensRemaining)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            ))}
          </div>

        </>
      ) : null}
    </section>
  );
}