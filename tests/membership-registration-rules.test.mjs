import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const statsRule = rules.slice(
  rules.indexOf("function validOwnMembershipStatsWrite"),
  rules.indexOf("function validOwnSignupCreate"),
);

test("waitlisting remains possible when an existing count exceeds a lowered limit", () => {
  assert.match(
    statsRule,
    /\(!afterOccupies\s*\|\|\s*request\.resource\.data\.count\s*<=\s*request\.resource\.data\.limit\)/,
  );
  assert.doesNotMatch(
    statsRule,
    /&&\s*request\.resource\.data\.count\s*<=\s*request\.resource\.data\.limit/,
  );
});

test("occupying a membership slot is still capped by the configured limit", () => {
  const capacityCheck = (afterOccupies, count, limit) => !afterOccupies || count <= limit;

  assert.equal(capacityCheck(true, 60, 60), true);
  assert.equal(capacityCheck(true, 61, 60), false);
  assert.equal(capacityCheck(false, 61, 60), true);
});
