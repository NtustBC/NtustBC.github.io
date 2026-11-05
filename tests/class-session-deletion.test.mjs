import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = readFileSync(new URL("../src/site.js", import.meta.url), "utf8");
const implementation = source.slice(source.indexOf("async function adminDeleteClassSession(sessionId)"), source.indexOf("async function handleClassSignupSubmit"));
function fixture(count = 2) {
  const documents = new Map([["sessions/s", { title: "社課", signupRequired: true }], ["stats/s", {}], ["albums/s", {}], ["rosters/orphan", { sessionId: "s" }], ["sessions/other", {}]]);
  for (let i = 0; i < count; i++) {
    documents.set(`signups/s-${i}`, { userId: `u${i}`, sessionId: "s" });
    documents.set(`rosters/s-${i}`, { sessionId: "s" });
  }
  let fail = false;
  const context = {
    db: {}, currentUser: { uid: "admin" }, currentUserIsAdmin: true, navigator: { onLine: true },
    CLASS_SIGNUP_COLLECTION: "signups", CLASS_PUBLIC_ROSTER_COLLECTION: "rosters", CLASS_SESSION_STATS_COLLECTION: "stats", MEMBER_NOTIFICATION_COLLECTION: "notifications",
    ensureAuthReady: async () => {}, doc: (_db, c, id) => `${c}/${id}`,
    getClassSessionDocRef: id => `sessions/${id}`, getClassAlbumDocRef: id => `albums/${id}`,
    collection: (_db, c) => c, where: (_key, _op, value) => value, query: (c, id) => ({ c, id }), serverTimestamp: () => "time",
    runTransaction: async (_db, callback) => callback({
      get: async ref => ({ exists: () => documents.has(ref), data: () => documents.get(ref) }),
      update: (ref, data) => documents.set(ref, { ...documents.get(ref), ...data }),
    }),
    getDocsFromServer: async ({ c, id }) => {
      if (documents.has("sessions/s")) assert.equal(documents.get("sessions/s").signupRequired, false);
      const docs = [...documents].filter(([key, value]) => key.startsWith(`${c}/`) && value.sessionId === id).map(([ref, value]) => ({ ref, id: ref.split("/")[1], data: () => value }));
      return { docs, size: docs.length };
    },
    writeBatch: () => {
      const writes = [];
      return { set: (ref, value) => writes.push([ref, value]), delete: ref => writes.push([ref, undefined]), commit: async () => {
        assert.ok(writes.length <= 500);
        if (fail) { fail = false; throw new Error("network failure"); }
        for (const [ref, value] of writes) value === undefined ? documents.delete(ref) : documents.set(ref, value);
      } };
    },
  };
  vm.runInNewContext(implementation, context);
  return { context, documents, remove: () => context.adminDeleteClassSession("s"), fail: () => { fail = true; } };
}
test("deleting a large session cleans associated data and notifies each member", async () => {
  const f = fixture(241);
  assert.equal((await f.remove()).notifiedCount, 241);
  assert.equal([...f.documents.keys()].filter(key => key.startsWith("notifications/")).length, 241);
  assert.equal(f.documents.size, 242);
  assert.ok(f.documents.has("sessions/other"));
  await f.remove();
  assert.equal(f.documents.size, 242);
});
test("failed cleanup leaves registration closed and can be retried", async () => {
  const f = fixture(); f.fail();
  await assert.rejects(f.remove(), /network failure/);
  assert.equal(f.documents.get("sessions/s").signupRequired, false);
  assert.ok(f.documents.has("signups/s-0"));
  await f.remove();
  assert.equal(f.documents.has("sessions/s"), false);
});
test("non-admins and offline clients cannot start deletion", async () => {
  const f = fixture(); f.context.currentUserIsAdmin = false;
  await assert.rejects(f.remove(), /管理員/);
  f.context.currentUserIsAdmin = true; f.context.navigator.onLine = false;
  await assert.rejects(f.remove(), /網路/);
  assert.equal(f.documents.get("sessions/s").signupRequired, true);
});
