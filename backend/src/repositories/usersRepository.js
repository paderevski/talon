import { createUsersPostgresRepository } from "./postgres/usersPostgresRepository.js";

let usersRepositoryPromise = null;

export function getUsersRepository() {
  if (!usersRepositoryPromise) {
    usersRepositoryPromise = Promise.resolve(createUsersPostgresRepository());
  }

  return usersRepositoryPromise;
}
