import {
  findUserByCredentials,
  findUserByUsername,
  getTeacherRoster,
  initializeUsersDatabase,
  listAdminRoster,
  listStudentUsernamesForTeacher,
} from "../../utils/usersDatabase.js";

export async function createUsersSqliteRepository() {
  await initializeUsersDatabase();

  return {
    findByCredentials: (username, password) =>
      findUserByCredentials(username, password),
    findByUsername: (username) => findUserByUsername(username),
    findById: (id) => findUserByUsername(id),
    recordLogin: async () => {},
    listStudentUsernamesForTeacher: (id) => listStudentUsernamesForTeacher(id),
    listAdminRoster: () => listAdminRoster(),
    getTeacherRoster: (username) => getTeacherRoster(username),
  };
}
