import { test } from "node:test";
import assert from "node:assert/strict";
import {
  conversationDisplay, describeCall, formatBytes, formatDuration, lastMessagePreview, readersOf,
} from "../src/lib/messagingUtils.ts";

const members = [
  { user_id: "me", name: "Me" },
  { user_id: "bob", name: "Bob", avatar_url: "https://x/bob.png" },
];

test("direct conversations are titled after the other person", () => {
  const d = conversationDisplay({ type: "direct", name: null, members }, "me");
  assert.equal(d.title, "Bob");
  assert.equal(d.otherUserId, "bob");
});

test("group conversations use the group name", () => {
  assert.equal(conversationDisplay({ type: "group", name: "Atlas", members }, "me").title, "Atlas");
});

test("previews handle files, deletion and own messages", () => {
  const base = { kind: "text" as const, body: "hi", attachment_name: null, sender_id: "me", deleted: false };
  assert.equal(lastMessagePreview(base, "me"), "You: hi");
  assert.equal(lastMessagePreview({ ...base, deleted: true }, "me"), "Message deleted");
  assert.match(lastMessagePreview({ ...base, kind: "file", attachment_name: "a.pdf" }, "bob"), /a\.pdf/);
  assert.equal(lastMessagePreview(null), "No messages yet");
});

test("read receipts come from read pointers and exclude the sender", () => {
  const msg = { sender_id: "me", created_at: "2026-01-01T10:00:00Z" };
  const reads = { me: "2026-01-01T10:00:00Z", bob: "2026-01-01T10:05:00Z", cat: "2026-01-01T09:00:00Z" };
  assert.deepEqual(readersOf(msg, reads, ["me", "bob", "cat"]), ["bob"]);
  assert.deepEqual(readersOf(msg, undefined, ["me", "bob"]), []);
});

test("call descriptions", () => {
  const c = { status: "ended", direction: "outgoing" as const, my_status: "left", duration_seconds: 75 };
  assert.equal(describeCall(c), "Outgoing · 1m 15s");
  assert.equal(describeCall({ ...c, status: "missed", direction: "incoming", duration_seconds: null }), "Missed");
  assert.equal(describeCall({ ...c, status: "declined", duration_seconds: null }), "Declined");
});

test("formatting helpers", () => {
  assert.equal(formatDuration(3725), "1h 2m");
  assert.equal(formatBytes(1536), "1.5 KB");
});
