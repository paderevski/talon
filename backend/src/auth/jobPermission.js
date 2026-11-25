// Whether a user may start jobs: the admin's per-user setting when there is
// one (users.can_run_jobs), otherwise the role default (students and admins
// can, teachers cannot). No imports, so services can use it without loading
// the auth middleware.
export function canRunJobsByDefault(roles) {
  return roles.includes("student") || roles.includes("admin");
}

export function canRunJobs(user) {
  if (typeof user?.canRunJobsOverride === "boolean") {
    return user.canRunJobsOverride;
  }
  return canRunJobsByDefault(user?.roles ?? [user?.role]);
}
