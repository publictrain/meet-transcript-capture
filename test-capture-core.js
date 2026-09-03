"use strict";

const assert = require("node:assert/strict");
const {
  TranscriptStore,
  isSameUtterance,
  normalizeCaption,
} = require("./capture-core.js");

assert.equal(normalizeCaption("  おはよう\nございます  "), "おはよう ございます");
assert.equal(isSameUtterance("本日は", "本日はよろしくお願いします"), true);
assert.equal(isSameUtterance("本日はよろしく", "本日は宜しくお願いします"), true);
assert.equal(isSameUtterance("最初の話題", "次の話題"), false);

const store = new TranscriptStore();
store.upsert("caption-1", "本日は", new Date("2026-08-27T01:00:00Z"));
store.upsert(
  "caption-1",
  "本日はよろしくお願いします",
  new Date("2026-08-27T01:00:01Z"),
);
store.upsert("caption-1", "次の話題です", new Date("2026-08-27T01:00:05Z"));
store.upsert("caption-2", "次の話題です", new Date("2026-08-27T01:00:05Z"));

assert.equal(store.lines.length, 2);
assert.equal(store.lines[0].text, "本日はよろしくお願いします");
assert.equal(store.lines[1].text, "次の話題です");

const output = store.toText({
  title: "動作確認会議",
  startedAt: new Date("2026-08-27T01:00:00Z"),
});
assert.match(output, /会議: 動作確認会議/);
assert.match(output, /本日はよろしくお願いします/);
assert.match(output, /次の話題です/);

console.log("meet transcript capture core: ok");
