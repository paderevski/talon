import { useCallback, useEffect, useState } from "react";
import { fetchAdminClasses, fetchAdminUsers } from "../api/client";
import AdminRosterPanel from "./AdminRosterPanel";
import AdminUsersPanel from "./AdminUsersPanel";
import AdminClassesPanel from "./AdminClassesPanel";
import AdminImportPanel from "./AdminImportPanel";

// Owns the users and classes lists shared by the admin views; any change
// calls reload() so every view (and the overview counts) stays in step.
// Renders only the admin view named by `view` (overview, users, classes,
// import); `sub` picks the users tab. Other views render nothing here.
export default function AdminConsole({ authUser, view, sub }) {
  const [users, setUsers] = useState([]);
  const [classes, setClasses] = useState([]);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);

  const reload = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAdminUsers(), fetchAdminClasses()])
      .then(([usersResponse, classesResponse]) => {
        if (!cancelled) {
          setUsers(usersResponse.users || []);
          setClasses(classesResponse.classes || []);
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

  if (view === "overview") {
    return <AdminRosterPanel authUser={authUser} refreshKey={version} />;
  }
  if (view === "users") {
    return (
      <>
        {errorBanner}
        <AdminUsersPanel users={users} classes={classes} authUser={authUser} onChanged={reload} tab={sub} />
      </>
    );
  }
  if (view === "classes") {
    return (
      <>
        {errorBanner}
        <AdminClassesPanel classes={classes} users={users} onChanged={reload} />
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
