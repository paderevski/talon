import { getUsersRepository } from "../repositories/usersRepository.js";

const usersRepository = await getUsersRepository();

function normalize(username) {
  return String(username ?? "").trim().toLowerCase();
}

export function hasRole(user, role) {
  return (user?.roles ?? [user?.role]).includes(role);
}

// Which owners' jobs/results a user may see: admins see everyone; everyone
// sees their own; teachers also see students in classes they teach.
export async function getAccessScope(user) {
  if (hasRole(user, "admin")) {
    return { all: true, usernames: new Set() };
  }

  const usernames = new Set([normalize(user.username)]);

  if (hasRole(user, "teacher")) {
    for (const username of await usersRepository.listStudentUsernamesForTeacher(user.id)) {
      usernames.add(normalize(username));
    }
  }

  return { all: false, usernames };
}

export function scopeAllows(scope, ownerUsername) {
  return scope.all || scope.usernames.has(normalize(ownerUsername));
}

// Changing a job (cancel, hide, unhide) is limited to its owner and admins;
// teachers can view their students' jobs but not change them.
export function canModify(user, ownerUsername) {
  return hasRole(user, "admin") || normalize(user?.username) === normalize(ownerUsername);
}

// Router middleware: req.accessScope for the signed-in user.
export async function attachAccessScope(req, _res, next) {
  try {
    req.accessScope = await getAccessScope(req.user);
    return next();
  } catch (error) {
    return next(error);
  }
}
