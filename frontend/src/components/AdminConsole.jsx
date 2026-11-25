import { useCallback, useEffect, useState } from "react";
import { fetchAdminClasses, fetchAdminUsers, fetchBudgetSummary } from "../api/client";
import AdminRosterPanel from "./AdminRosterPanel";
import AdminUsersPanel from "./AdminUsersPanel";
import AdminClassesPanel from "./AdminClassesPanel";
import AdminImportPanel from "./AdminImportPanel";
import AdminUnassignedPanel from "./AdminUnassignedPanel";
import AdminMoneyPanel from "./AdminMoneyPanel";
import { SchoolBalanceContext } from "./schoolBalance";

// Owns the users and classes lists shared by the admin views; any change
// calls reload() so every view (and the overview counts) stays in step.
// Renders only the admin view named by `view` (overview, users, classes,
// unassigned, import); `sub` picks the users tab. Other views render nothing here.
export default function AdminConsole({ authUser, view, sub }) {
  const [users, setUsers] = useState([]);
  const [classes, setClasses] = useState([]);
  // The School account's balance: the most an admin control can add.
  const [schoolBalance, setSchoolBalance] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);

  const reload = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAdminUsers(), fetchAdminClasses(), fetchBudgetSummary()])
      .then(([usersResponse, classesResponse, summaryResponse]) => {
        if (!cancelled) {
          setUsers(usersResponse.users || []);
          setClasses(classesResponse.classes || []);
          setSchoolBalance(typeof summaryResponse?.summary?.school === "number" ? summaryResponse.summary.school : null);
          setError("");
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError.message || "Unable to load users and classes");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const errorBanner = error ? <div className="repo-error">{error}</div> : null;
  const provide = (content) => <SchoolBalanceContext.Provider value={schoolBalance}>{content}</SchoolBalanceContext.Provider>;

  if (view === "overview") {
    return (
      <>
        <AdminMoneyPanel refreshKey={version} onChanged={reload} />
        <AdminRosterPanel authUser={authUser} refreshKey={version} />
      </>
    );
  }
  if (view === "users") {
    return provide(
      <>
        {errorBanner}
        <AdminUsersPanel users={users} classes={classes} authUser={authUser} onChanged={reload} tab={sub} />
      </>,
    );
  }
  if (view === "classes") {
    return provide(
      <>
        {errorBanner}
        <AdminClassesPanel classes={classes} users={users} onChanged={reload} />
      </>,
    );
  }
  if (view === "unassigned") {
    return (
      <>
        {errorBanner}
        <AdminUnassignedPanel users={users} classes={classes} onChanged={reload} />
      </>
    );
  }
  if (view === "import") {
    return (
      <>
        {errorBanner}
        <AdminImportPanel onChanged={reload} />
      </>
    );
  }
  return null;
}
