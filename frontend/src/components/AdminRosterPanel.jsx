import { useEffect, useState } from "react";
import { fetchAdminRoster } from "../api/client";

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

export default function AdminRosterPanel({ authUser }) {
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
  }, [authUser]);

  return (
    <section className="panel" id="admin-roster">
      <div className="panel-head">
        <h2 className="panel-title">Admin Roster</h2>
      </div>

      {error ? <div className="repo-error">{error}</div> : null}
      {isLoading ? <div className="form-hint">Loading roster from SQLite...</div> : null}

      {!isLoading ? (
        <>
          <div className="results-grid">
            <div className="result-card">
              <div className="result-job-name">Users</div>
              <div className="result-meta-value mono-sm">{roster.stats.userCount}</div>
            </div>
            <div className="result-card">
              <div className="result-job-name">Teachers</div>
              <div className="result-meta-value mono-sm">{roster.stats.teacherCount}</div>
            </div>
            <div className="result-card">
              <div className="result-job-name">Students</div>
              <div className="result-meta-value mono-sm">{roster.stats.studentCount}</div>
            </div>
            <div className="result-card">
              <div className="result-job-name">Admins</div>
              <div className="result-meta-value mono-sm">{roster.stats.adminCount}</div>
            </div>
            <div className="result-card">
              <div className="result-job-name">Classes</div>
              <div className="result-meta-value mono-sm">{roster.stats.classCount}</div>
            </div>
          </div>

          <div className="panel-head">
            <h3 className="panel-title">Teachers</h3>
          </div>
          <div className="table-card table-scroll-region">
            <table>
              <thead>
                <tr>
                  <th>Teacher</th>
                  <th>Username</th>
                  <th>Class</th>
                  <th>Students</th>
                </tr>
              </thead>
              <tbody>
                {roster.teachers.map((teacher) => (
                  <tr key={teacher.username}>
                    <td>{teacher.fullName}</td>
                    <td className="mono-sm">{teacher.username}</td>
                    <td>{teacher.className}</td>
                    <td>{teacher.students.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel-head">
            <h3 className="panel-title">Classes</h3>
          </div>
          <div className="results-grid">
            {roster.classes.map((classItem) => (
              <article key={`${classItem.teacherUsername}-${classItem.className}`} className="result-card">
                <div className="result-card-head">
                  <div className="result-job-name">{classItem.className}</div>
                  <span className="status-pill queued">
                    <span className="sdot" />
                    {classItem.students.length} students
                  </span>
                </div>
                <div className="form-hint">Teacher: {classItem.teacherFullName}</div>
                <div className="form-hint mono-sm">{classItem.teacherUsername}</div>
                <table>
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Quota</th>
                      <th>Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {classItem.students.map((student) => (
                      <tr key={student.username}>
                        <td>
                          {student.fullName}
                          <div className="form-hint mono-sm">{student.username}</div>
                        </td>
                        <td>{student.quota}</td>
                        <td>{student.tokensRemaining}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            ))}
          </div>

          <div className="panel-head">
            <h3 className="panel-title">Admins</h3>
          </div>
          <div className="table-card table-scroll-region">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                </tr>
              </thead>
              <tbody>
                {roster.admins.map((admin) => (
                  <tr key={admin.username}>
                    <td>{admin.fullName}</td>
                    <td className="mono-sm">{admin.username}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}