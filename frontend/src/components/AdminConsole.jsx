import { useCallback, useEffect, useState } from "react";
import { fetchAdminClasses, fetchAdminUsers } from "../api/client";
import AdminRosterPanel from "./AdminRosterPanel";
import AdminUsersPanel from "./AdminUsersPanel";
import AdminClassesPanel from "./AdminClassesPanel";
import AdminImportPanel from "./AdminImportPanel";

// Owns the users and classes lists shared by the admin panels; any change
// calls reload() so every panel (and the overview counts) stays in step.
export default function AdminConsole({ authUser }) {
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

  return (
    <>
      <AdminRosterPanel authUser={authUser} refreshKey={version} />
      {error ? <div className="repo-error">{error}</div> : null}
      <AdminUsersPanel users={users} classes={classes} authUser={authUser} onChanged={reload} />
      <AdminImportPanel onChanged={reload} />
      <AdminClassesPanel classes={classes} users={users} onChanged={reload} />
    </>
  );
}
