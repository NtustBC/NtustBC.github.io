import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const siteSource = readFileSync(new URL("../src/site.js", import.meta.url), "utf8");
const firebaseModules = readFileSync(new URL("../src/firebase-modules.js", import.meta.url), "utf8");
const functionsSource = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");

test("forgot-password submits an administrator-reviewed request without sending email", () => {
  assert.match(siteSource, /httpsCallable\(functionsClient, "requestVerifiedPasswordReset"\)/);
  assert.match(siteSource, /管理員會在網站通知中心收到申請/);
  assert.doesNotMatch(siteSource, /sendPasswordResetEmail/);
  assert.doesNotMatch(firebaseModules, /sendPasswordResetEmail/);
});

test("password reset requests notify administrators without revealing missing accounts", () => {
  assert.match(functionsSource, /exports\.requestVerifiedPasswordReset = onCall/);
  assert.match(functionsSource, /getUserByEmail\(email\)/);
  assert.match(functionsSource, /if \(error\?\.code === "auth\/user-not-found"\) return \{ ok: true \}/);
  assert.match(functionsSource, /collection\("adminNotifications"\)\.doc\(`password-reset-/);
  assert.match(functionsSource, /collection\("passwordResetRateLimits"\)/);
});

test("only administrators can set another account password", () => {
  assert.match(functionsSource, /exports\.adminResetMemberPassword = onCall/);
  assert.match(functionsSource, /collection\("admins"\)\.doc\(callerUid\)/);
  assert.match(functionsSource, /admin\.auth\(\)\.updateUser\(uid, \{ password: newPassword \}\)/);
  assert.match(siteSource, /data-admin-password-reset-form/);
  assert.match(siteSource, /data-member-password-reset/);
});

test("signed-in users can change their own password after reauthentication", () => {
  assert.match(siteSource, /reauthenticateWithCredential\(accountUser, credential\)/);
  assert.match(siteSource, /updatePassword\(accountUser, newPassword\)/);
  assert.match(siteSource, /data-update-account-password/);
});
