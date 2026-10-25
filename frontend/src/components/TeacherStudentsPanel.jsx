import { useEffect, useState } from "react";
import { fetchTeacherRoster } from "../api/client";

const emptyRoster = {
  teacher: {
    username: "",
    fullName: "",
    className: "",
  },
  students: [],
};

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
            <div className="result-job-name">Class</div>
            <div>{roster.teacher.className || "Unassigned"}</div>
            <div className="form-hint">Students: {roster.students.length}</div>
          </div>
        </div>
      ) : null}

      {isLoading ? <div className="form-hint">Loading student roster...</div> : null}

      {!isLoading && !error ? (
        <div className="table-card table-scroll-region">
          <table>
            <thead>
              <tr>
                <th>Student</th>
                <th>Username</th>
                <th>Quota</th>
                <th>Tokens Remaining</th>
                <th>Workspace</th>
              </tr>
            </thead>
            <tbody>
              {roster.students.map((student) => (
                <tr key={student.username}>
                  <td>{student.fullName}</td>
                  <td className="mono-sm">{student.username}</td>
                  <td>{student.quota}</td>
                  <td>{student.tokensRemaining}</td>
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
      ) : null}
    </section>
  );
}