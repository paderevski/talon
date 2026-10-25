import { createUsersSqliteRepository } from "./sqlite/usersSqliteRepository.js";
import { createUsersPostgresRepository } from "./postgres/usersPostgresRepository.js";

let usersRepositoryPromise = null;

export function getUsersRepository(
  provider = process.env.USERS_REPOSITORY_PROVIDER || "sqlite",
) {
  const normalizedProvider = String(provider).trim().toLowerCase();

  if (!usersRepositoryPromise) {
    if (normalizedProvider === "sqlite") {
      usersRepositoryPromise = createUsersSqliteRepository();
    } else if (normalizedProvider === "postgres") {
      usersRepositoryPromise = Promise.resolve(createUsersPostgresRepository());
    } else {
      throw new Error(
        `Unsupported users repository provider: ${normalizedProvider}`,
      );
    }
  }

  return usersRepositoryPromise;
}
