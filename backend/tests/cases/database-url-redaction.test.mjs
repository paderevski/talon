import { assert } from "../lib/harness.mjs";
import { describeDatabase } from "../../src/db/pool.js";

export const name = "database url is redacted for logs";

export async function run() {
  const withPassword = describeDatabase("postgres://talon:s3cretPW@db.example.com:5432/talon?sslmode=require");
  assert(!withPassword.includes("s3cretPW"), `password leaked: ${withPassword}`);
  assert(withPassword.includes("talon:****@db.example.com"), `unexpected format: ${withPassword}`);

  const queryPassword = describeDatabase("postgres://db.example.com/talon?user=talon&password=s3cretPW");
  assert(!queryPassword.includes("s3cretPW"), `query password leaked: ${queryPassword}`);

  const socket = describeDatabase("postgres://talon@%2Fvar%2Frun%2Fpostgresql/talon");
  assert(socket.includes("talon@"), `socket url mangled: ${socket}`);

  assert(!describeDatabase("not a url at all s3cretPW").includes("s3cretPW"), "unparseable url leaked");
}
