import { teacherSeeds } from "../data/demoUsers.js";

const studentUsernames = teacherSeeds
  .flatMap((teacher) =>
    (teacher.students || []).map((student) =>
      String(student.username ?? "").trim(),
    ),
  )
  .filter(Boolean);

function hashSeed(value) {
  const normalizedValue = String(value ?? "").trim();
  let hash = 0;

  for (let index = 0; index < normalizedValue.length; index += 1) {
    hash = (hash << 5) - hash + normalizedValue.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

export function getDemoStudentUsernames() {
  return [...studentUsernames];
}

export function assignDemoStudentOwner(seedValue) {
  if (!studentUsernames.length) {
    return "";
  }

  const index = hashSeed(seedValue) % studentUsernames.length;
  return studentUsernames[index];
}

export function withOwnedJob(job) {
  const normalizedCost = String(job?.cost ?? "").trim() || "$0.00";
  const ownerUsername =
    String(job?.ownerUsername ?? "").trim() ||
    assignDemoStudentOwner(
      job?.id || job?.executionRef?.executionId || job?.name || job?.repo,
    );

  return {
    ...job,
    cost: normalizedCost,
    ownerUsername,
  };
}

export function withOwnedResult(result) {
  const ownerUsername =
    String(result?.ownerUsername ?? "").trim() ||
    assignDemoStudentOwner(
      result?.jobId || result?.id || result?.name || result?.repo,
    );

  return {
    ...result,
    ownerUsername,
  };
}
