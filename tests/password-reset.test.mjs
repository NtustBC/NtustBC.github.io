import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const siteSource = readFileSync(new URL("../src/site.js", import.meta.url), "utf8");
const firebaseModules = readFileSync(new URL("../src/firebase-modules.js", import.meta.url), "utf8");
const functionsSource = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");

test("password recovery uses built-in Authentication without Cloud Functions", () => {
  assert.match(firebaseModules, /sendPasswordResetEmail/);
  assert.match(siteSource, /await sendPasswordResetEmail\(auth, email\)/);
  assert.doesNotMatch(siteSource, /httpsCallable\(functionsClient, "(?:requestVerifiedPasswordReset|adminResetMemberPassword)"\)/);
  assert.doesNotMatch(siteSource, /不會寄送電子郵件|管理員人工審核同意後|admin-new-password/);
});

test("password reset hides missing accounts but propagates delivery failures", async () => {
  const source = siteSource.slice(siteSource.indexOf("const sendAccountPasswordReset ="), siteSource.indexOf("const handlePasswordResetSubmit ="));
  const calls = [];
  let failure;
  const context = {
    auth: {}, ensureAuthReady: async () => {},
    sendPasswordResetEmail: async (auth, email) => {
      calls.push({ language: auth.languageCode, email });
      if (failure) throw failure;
    },
  };
  runInNewContext(source + "\nglobalThis.sendReset = sendAccountPasswordReset;", context);
  await context.sendReset("member@example.com");
  assert.deepEqual(calls[0], { language: "zh-TW", email: "member@example.com" });
  failure = { code: "auth/user-not-found" };
  await context.sendReset("missing@example.com");
  for (const code of ["auth/too-many-requests", "auth/network-request-failed"]) {
    failure = { code };
    await assert.rejects(context.sendReset("member@example.com"), (error) => error.code === code);
  }
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

test("administrator must explicitly verify identity before any password update", async () => {
  const handlerSource = functionsSource.slice(
    functionsSource.indexOf("exports.adminResetMemberPassword ="),
    functionsSource.indexOf("exports.deleteMemberAccount ="),
  );
  let passwordUpdated = false;
  const context = {
    exports: {}, CALLABLE_OPTIONS: {}, onCall: (_options, handler) => handler,
    HttpsError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    admin: {
      firestore: () => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: true }) }) }) }),
      auth: () => ({ updateUser: async () => { passwordUpdated = true; } }),
    },
  };
  runInNewContext(handlerSource, context);
  for (const identityVerified of [undefined, false, "true"]) {
    await assert.rejects(context.exports.adminResetMemberPassword({
      auth: { uid: "admin" }, data: { uid: "member", newPassword: "password123", identityVerified },
    }), (error) => error.code === "failed-precondition");
  }
  assert.equal(passwordUpdated, false);
});

test("failed reset writes can be retried without consuming the cooldown", async () => {
  const handlerSource = functionsSource.slice(
    functionsSource.indexOf("exports.requestVerifiedPasswordReset ="),
    functionsSource.indexOf("exports.adminResetMemberPassword ="),
  );
  const stored = new Map();
  let failCommit = true;
  const firestore = {
    collection: (name) => ({ doc: (id) => ({
      path: `${name}/${id}`, get: async () => ({ exists: true, data: () => ({ name: "Member" }) }),
    }) }),
    runTransaction: async (callback) => {
      const writes = [];
      const result = await callback({
        get: async (ref) => ({ data: () => stored.get(ref.path) }),
        set: (ref, data) => writes.push([ref.path, data]),
      });
      if (failCommit) throw new Error("storage unavailable");
      for (const [path, data] of writes) stored.set(path, data);
      return result;
    },
  };
  const context = {
    exports: {}, CALLABLE_OPTIONS: {}, onCall: (_options, handler) => handler,
    normalizedEmail: (value) => value.trim().toLowerCase(),
    crypto: { createHash: () => ({ update: () => ({ digest: () => "hash" }) }) },
    logger: { info() {}, error() {} },
    admin: {
      firestore: Object.assign(() => firestore, {
        Timestamp: { now: () => ({ toMillis: () => 1000 }) },
        FieldValue: { serverTimestamp: () => "timestamp" },
      }),
      auth: () => ({ getUserByEmail: async () => ({ uid: "member" }) }),
    },
  };
  runInNewContext(handlerSource, context);
  const request = { data: { email: "member@example.com" } };
  await assert.rejects(context.exports.requestVerifiedPasswordReset(request), /storage unavailable/);
  assert.equal(stored.size, 0);
  failCommit = false;
  assert.equal((await context.exports.requestVerifiedPasswordReset(request)).ok, true);
  assert.equal(stored.get("passwordResetRequests/member").status, "pending");
  assert.equal(stored.get("adminNotifications/password-reset-member").status, "pending");
  assert.ok(stored.has("passwordResetRateLimits/hash"));
});
