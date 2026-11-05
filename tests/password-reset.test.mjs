import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const siteSource = readFileSync(new URL("../src/site.js", import.meta.url), "utf8");
const firebaseModules = readFileSync(new URL("../src/firebase-modules.js", import.meta.url), "utf8");
const functionsSource = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");

test("manual recovery requires all four fields and never sends automatic reset email", () => {
  for (const name of ["email", "name", "studentId", "phone"]) {
    assert.match(siteSource, new RegExp(`name="${name}"[^>]*required`));
  }
  assert.doesNotMatch(siteSource, /sendPasswordResetEmail|sendAccountPasswordReset/);
  assert.doesNotMatch(firebaseModules, /sendPasswordResetEmail/);
  assert.match(siteSource, /管理員會在通知中心收到通知/);
});

test("manual requests write notifications without email or clipboard", async () => {
  const source = siteSource.slice(siteSource.indexOf("const submitManualPasswordReset ="), siteSource.indexOf("const handlePasswordResetSubmit ="));
  const writes = [];
  const context = { ensureAuthReady: async () => {}, db: {}, ADMIN_NOTIFICATION_COLLECTION: "adminNotifications",
    doc: (_db, collection, id) => ({ collection, id }), serverTimestamp: () => "server-time",
    setDoc: async (ref, data) => writes.push({ ref, data }) };
  runInNewContext(source + "\nglobalThis.submit = submitManualPasswordReset;", context);
  await context.submit({ email: "member@example.com", name: "Member", studentId: "B123", phone: "0912345678" });
  assert.equal(writes[0].ref.id, "password-reset-member@example.com");
  assert.equal(writes[0].data.status, "pending");
  assert.equal(writes[0].data.requestedAt, "server-time");
  assert.match(siteSource, /確認是本人/);
  const handler = siteSource.slice(siteSource.indexOf("const handlePasswordResetSubmit ="), siteSource.indexOf("const bindPasswordResetModalEvents ="));
  assert.doesNotMatch(handler, /mailto:|clipboard|httpsCallable/);
});

test("identity confirmation is admin-only and rejects already processed requests", async () => {
  const source = siteSource.slice(siteSource.indexOf("const confirmPasswordResetIdentity ="), siteSource.indexOf("const bindPasswordResetModalEvents ="));
  const updates = [];
  let status = "pending";
  const context = { currentUserIsAdmin: false, currentUser: { uid: "admin" }, db: {},
    ADMIN_NOTIFICATION_COLLECTION: "adminNotifications", doc: () => "ref", serverTimestamp: () => "time",
    runTransaction: async (_db, callback) => callback({
      get: async () => ({ exists: () => true, data: () => ({ type: "password_reset_requested", status }) }),
      update: (_ref, data) => updates.push(data),
    }),
  };
  runInNewContext(source + "\nglobalThis.confirm = confirmPasswordResetIdentity;", context);
  await assert.rejects(context.confirm("request"), /只有管理員/);
  context.currentUserIsAdmin = true;
  await context.confirm("request");
  assert.equal(updates[0].status, "identity_verified");
  assert.equal(updates[0].verifiedBy, "admin");
  status = "identity_verified";
  await assert.rejects(context.confirm("request"), /已處理/);
  assert.equal(updates.length, 1);
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
