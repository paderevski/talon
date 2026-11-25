import { getUsersRepository } from "../repositories/usersRepository.js";
import { sessionMaxMs } from "./session.js";

const usersRepository = await getUsersRepository();

function destroySession(req) {
  return new Promise((resolve) => {
    req.session.destroy(() => resolve());
  });
}

// Sets req.user from the session (or null). Drops sessions whose user has
// been deleted or disabled since they signed in, and sessions older than
// sessionMaxMs however active (a session from before this rule gets its
// clock started now rather than everyone being signed out at once).
export async function attachUser(req, _res, next) {
  req.user = null;
  const userId = req.session?.userId;

  if (!userId) {
    return next();
  }

  const signedInAt = Number(req.session.signedInAt);
  if (!Number.isFinite(signedInAt) || signedInAt <= 0) {
    req.session.signedInAt = Date.now();
  } else if (Date.now() - signedInAt > sessionMaxMs()) {
    await destroySession(req);
    return next();
  }

  try {
    const user = await usersRepository.findById(userId);

    if (!user || (user.status && user.status !== "active")) {
      await destroySession(req);
      return next();
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: "Sign in required" });
  }

  return next();
}

// 403 unless the signed-in user has any of the given roles.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Sign in required" });
    }

    const userRoles = req.user.roles ?? [req.user.role];
    if (!roles.some((role) => userRoles.includes(role))) {
      return res.status(403).json({ message: `Requires role: ${roles.join(" or ")}` });
    }

    return next();
  };
}

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    roles: user.roles ?? [user.role],
    localSignIn: user.localSignIn !== false,
    inClass: user.inClass === true,
  };
}
