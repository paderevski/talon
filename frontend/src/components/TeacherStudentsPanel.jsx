import { useCallback, useEffect, useState } from "react";
import { allocateStudentBudget, fetchTeacherRoster } from "../api/client";
import { formatClassName, formatDollars } from "../utils/format";
import BudgetAdjuster from "./BudgetAdjuster";

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
// onAllocate is omitted for read-only use; the remaining balance is then
// shown without the add/subtract control.
export function ClassTables({ classes, onOpenStudentView, onAllocate, poolBalance = null }) {
  return classes.map((classItem) => (
    <div key={classItem.id ?? classItem.className}>
      <div className="panel-head subhead">
        <h3 className="panel-title">{formatClassName(classItem.className, classItem.block)}</h3>
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
                <td>
                  {onAllocate ? (
                    <BudgetAdjuster
                      who={student.fullName}
                      balance={student.tokensRemaining}
                      addLimit={poolBalance}
                      subtractLimit={student.tokensRemaining}
                      onAdjust={(direction, amount) => onAllocate(student, direction, amount)}
                    />
                  ) : (
                    formatDollars(student.tokensRemaining)
                  )}
                </td>
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
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [version, setVersion] = useState(0);

  // Errors are shown by the row's control (BudgetAdjuster), so rethrow.
  const onAllocate = useCallback(async (student, direction, amount) => {
    setActionMessage("");
    setActionError("");
    await allocateStudentBudget(student.username, amount, direction === "add" ? "give" : "take");
    setActionMessage(
      direction === "add"
        ? `Added ${formatDollars(amount)} to ${student.fullName} from your pool`
        : `Returned ${formatDollars(amount)} from ${student.fullName} to your pool`,
    );
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!authUser?.username) {
      setRoster(emptyRoster);
      setError("");
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(version === 0);
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
  }, [authUser, version]);

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
            <div className="form-hint">Add moves money from here to a student; Subtract returns it here</div>
          </div>
        </div>
      ) : null}

      {/* Reserved height so a message appearing does not push the tables down. */}
      <div className="feedback-slot" aria-live="polite">
        {actionMessage ? <div className="notice-ok">{actionMessage}</div> : null}
        {actionError ? <div className="repo-error">{actionError}</div> : null}
      </div>

      {isLoading ? <div className="form-hint">Loading student roster...</div> : null}

      {!isLoading && !error && roster.classes.length === 0 ? (
        <div className="form-hint">You are not assigned to any classes yet.</div>
      ) : null}

      {!isLoading && !error ? <ClassTables classes={roster.classes} onOpenStudentView={onOpenStudentView} onAllocate={onAllocate} poolBalance={roster.teacher.poolBalance} /> : null}
    </section>
  );
}