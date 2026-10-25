import { createUsersSqliteRepository } from "./sqlite/usersSqliteRepository.js";

let usersRepositoryPromise = null;

export function getUsersRepository(
  provider = process.env.USERS_REPOSITORY_PROVIDER || "sqlite",
) {
  const normalizedProvider = String(provider).trim().toLowerCase();

  if (normalizedProvider !== "sqlite") {
    throw new Error(
      `Unsupported users repository provider: ${normalizedProvider}`,
    );
  }

  if (!usersRepositoryPromise) {
    usersRepositoryPromise = createUsersSqliteRepository();
  }

  return usersRepositoryPromise;
}
