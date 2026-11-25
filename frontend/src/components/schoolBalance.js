import { createContext, useContext } from "react";

// The School account's balance in dollars (null: not loaded), provided by
// AdminConsole. Admin budget controls use it as the most they can add, since
// every pool and personal budget is funded from School.
export const SchoolBalanceContext = createContext(null);

export function useSchoolBalance() {
  return useContext(SchoolBalanceContext);
}

// Props for a BudgetAdjuster that adds from the School account.
export function schoolAddProps(schoolBalance) {
  return schoolBalance === null ? {} : { addLimit: schoolBalance, addSource: "The School account" };
}
