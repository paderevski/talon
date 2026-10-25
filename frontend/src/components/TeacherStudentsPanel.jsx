import { useEffect, useState } from "react";
import { fetchTeacherRoster } from "../api/client";
import { formatDollars } from "../utils/format";

const emptyRoster = {
  teacher: {
    username: "",
    fullName: "",
    className: "",
    poolBalance: 0,
  },
  classes: [],
  students: [],
};


// One section per class the teacher teaches, each with its own student table.
export function ClassTables({ classes, onOpenStudentView }) {
  return classes.map((classItem) => (
    <div key={classItem.id ?? classItem.className}>
      <div className="panel-head subhead">
        <h3 className="panel-title">{classItem.className}</h3>
        <span className="status-pill queued">
          <span className="sdot" />
          {classItem.students.length} student{classItem.students.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="table-card table-scroll-region">
        <table>
          <thead>
            <tr>
              <th>Student</th>
              <th>Username</th>
              <th>Allocated</th>
              <th>Remaining</th>
              <th>Workspace</th>
            </tr>
          </thead>
          <tbody>
            {classItem.students.map((student) => (
              <tr key={student.username}>
                <td>{student.fullName}</td>
                <td className="mono-sm">{student.username}</td>
                <td>{formatDollars(student.quota)}</td>
                <td>{formatDollars(student.tokensRemaining)}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onOpenStudentView(student)}
                  >
                    Open Student View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  ));
}

export default function TeacherStudentsPanel({ authUser, onOpenStudentView }) {
  const [roster, setRoster] = useState(emptyRoster);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!authUser?.username) {
      setRoster(emptyRoster);
      setError("");
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError("");

    fetchTeacherRoster()
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
        setError(nextError.message || "Unable to load teacher roster");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authUser]);

  return (
    <section className="panel" id="teacher-students">
      <div className="panel-head">
        <h2 className="panel-title">Class Roster</h2>
      </div>

      {error ? <div className="repo-error">{error}</div> : null}

      {!error ? (
        <div className="results-grid">
          <div className="result-card">
            <div className="result-job-name">Teacher</div>
            <div>{roster.teacher.fullName || authUser?.username}</div>
            <div className="form-hint mono-sm">{roster.teacher.username || authUser?.username}</div>
          </div>
          <div className="result-card">
            <div className="result-job-name">Classes</div>
            <div className="result-meta-value mono-sm">{roster.classes.length}</div>
            <div className="form-hint">Students: {roster.students.length}</div>
          </div>
          <div className="result-card">
            <div className="result-job-name">Budget pool</div>
            <div className="result-meta-value mono-sm">{formatDollars(roster.teacher.poolBalance)}</div>
            <div className="form-hint">Available to allocate to students</div>
          </div>
        </div>
      ) : null}

      {isLoading ? <div className="form-hint">Loading student roster...</div> : null}

      {!isLoading && !error && roster.classes.length === 0 ? (
        <div className="form-hint">You are not assigned to any classes yet.</div>
      ) : null}

      {!isLoading && !error ? <ClassTables classes={roster.classes} onOpenStudentView={onOpenStudentView} /> : null}
    </section>
  );
}