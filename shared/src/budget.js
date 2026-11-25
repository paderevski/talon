// What to do when your budget is empty depends on who you are: students ask
// their teacher, teachers move money from their class pool to themselves,
// admins from the School account. `roles` is the user's role list.
export function moreBudgetHint(roles) {
  roles = roles || [];
  if (roles.includes("admin")) {
    return "Move money from the School account to yourself (Admin > Users).";
  }
  if (roles.includes("teacher")) {
    return "Move money from your class pool to yourself (Teaching > Students).";
  }
  return "Ask your teacher for more.";
}
