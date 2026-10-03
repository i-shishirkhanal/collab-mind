// Phase 4 regression: an AI answer must show up even when the socket never delivers it, and never twice when it does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMessage, replaceOptimistic } from "../src/lib/chatMessages.ts";

const m = (id: string, content = id) => ({ id, content });

test("a message already in the list is not added again (socket + REST both deliver the answer)", () => {
  const once = mergeMessage([m("u1")], m("a1"));
  assert.deepEqual(once.map((x) => x.id), ["u1", "a1"]);
  assert.equal(mergeMessage(once, m("a1")), once, "same array back: no duplicate, no re-render");
});

test("the REST answer is added when the socket never delivered it", () => {
  assert.deepEqual(mergeMessage([m("local-1")], m("a1")).map((x) => x.id), ["local-1", "a1"]);
});

test("the optimistic user message is replaced in place by the persisted one", () => {
  const list = [m("old"), m("local-1", "q"), m("later")];
  assert.deepEqual(replaceOptimistic(list, "local-1", m("u9", "q")).map((x) => x.id), ["old", "u9", "later"]);
});

test("if the persisted user message already arrived via the socket, the optimistic copy is dropped", () => {
  assert.deepEqual(replaceOptimistic([m("local-1"), m("u9")], "local-1", m("u9")).map((x) => x.id), ["u9"]);
});

test("a missing optimistic copy just appends the persisted message", () => {
  assert.deepEqual(replaceOptimistic([m("x")], "local-gone", m("u9")).map((x) => x.id), ["x", "u9"]);
});
