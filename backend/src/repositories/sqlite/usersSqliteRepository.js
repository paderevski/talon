import {
  findUserByCredentials,
  findUserByUsername,
  getTeacherRoster,
  initializeUsersDatabase,
  listAdminRoster,
} from "../../utils/usersDatabase.js";

export async function createUsersSqliteRepository() {
  await initializeUsersDatabase();

  return {
    findByCredentials: (username, password) =>
      findUserByCredentials(username, password),
    findByUsername: (username) => findUserByUsername(username),
    findById: (id) => findUserByUsername(id),
    recordLogin: async () => {},
    listAdminRoster: () => listAdminRoster(),
    getTeacherRoster: (username) => getTeacherRoster(username),
  };
}
