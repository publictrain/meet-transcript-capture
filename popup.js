"use strict";

const historyElement = document.querySelector(".history");
const emptyElement = document.querySelector(".empty");
const viewerElement = document.querySelector(".viewer");
const textareaElement = document.querySelector("textarea");
const selectButton = document.querySelector("button.select");
const statusElement = document.querySelector(".status");

function formatSavedAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "保存日時不明"
    : date.toLocaleString("ja-JP");
}

function createRecordButton(record, { active = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `record${active ? " active" : ""}`;

  const title = document.createElement("span");
  title.className = "record-title";
  title.textContent = record.title || "会議";

  const time = document.createElement("span");
  time.className = "record-time";
  time.textContent = active
    ? `記録中・仮保存 ${formatSavedAt(record.updatedAt)}`
    : formatSavedAt(record.savedAt);

  const preview = document.createElement("span");
  preview.className = "record-preview";
  preview.textContent = String(record.text || "")
    .split("\n")
    .filter(Boolean)
    .at(-1) || "本文なし";

  button.append(title, time, preview);
  button.addEventListener("click", () => {
    textareaElement.value = record.text || "";
    viewerElement.hidden = false;
    statusElement.textContent = "「全文を選択」→ ⌘C でコピーできます。";
  });
  return button;
}

async function loadHistory() {
  const stored = await chrome.storage.local.get([
    "activeTranscript",
    "transcriptHistory",
  ]);
  const history = Array.isArray(stored.transcriptHistory)
    ? stored.transcriptHistory
    : [];
  const records = [];

  if (typeof stored.activeTranscript?.text === "string") {
    records.push({ record: stored.activeTranscript, active: true });
  }
  for (const record of history) {
    if (typeof record?.text === "string" && record.id !== stored.activeTranscript?.id) {
      records.push({ record, active: false });
    }
  }

  emptyElement.hidden = records.length > 0;
  for (const item of records.slice(0, 20)) {
    historyElement.append(createRecordButton(item.record, { active: item.active }));
  }
}

selectButton.addEventListener("click", () => {
  textareaElement.focus();
  textareaElement.select();
  statusElement.textContent = "選択しました。⌘Cでコピーしてください。";
});

void loadHistory().catch((error) => {
  console.error("会議文字起こし履歴を読み込めませんでした", error);
  emptyElement.hidden = false;
  emptyElement.textContent = "履歴を読み込めませんでした。";
});
