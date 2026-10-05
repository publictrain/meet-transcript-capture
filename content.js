(function initializeMeetingTranscriptCapture() {
  "use strict";

  const { TranscriptStore, getMeetingPlatform } = window.MeetingTranscriptCapture;
  const platform = getMeetingPlatform(location.hostname);
  if (!platform) {
    return;
  }

  // Zoomの会議UIはwebclient iframe内にある。all_framesで読み込みつつ、
  // トップページや補助iframeにはパネルを重複表示しない。
  if (platform.requiredFrameId && window.frameElement?.id !== platform.requiredFrameId) {
    return;
  }

  if (window.__meetingTranscriptCaptureLoaded) {
    return;
  }
  window.__meetingTranscriptCaptureLoaded = true;

  const CAPTION_SELECTORS = platform.captionSelectors;
  const extensionTitle = "Meet / Zoom 字幕保存";

  let transcript = new TranscriptStore();
  let startedAt = null;
  let isCapturing = false;
  let observer = null;
  let scanTimer = null;
  let checkpointTimer = null;
  let nextSourceId = 1;
  let captureId = null;
  let hadActiveCall = false;
  let callMissingSince = null;
  let latestTranscriptText = "";
  let lastVisibleSourceIds = new Set();
  const sourceIdByElement = new WeakMap();

  const host = document.createElement("div");
  host.id = "meet-transcript-capture";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        position: fixed;
        right: 16px;
        bottom: 88px;
        z-index: 2147483647;
        width: 330px;
        box-sizing: border-box;
        padding: 12px;
        border: 1px solid #dadce0;
        border-radius: 12px;
        background: #fff;
        color: #202124;
        box-shadow: 0 4px 18px rgba(60, 64, 67, .3);
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .title { margin: 0 0 8px; font-size: 14px; font-weight: 700; }
      .status { min-height: 39px; margin-bottom: 8px; color: #5f6368; }
      .status[data-active="true"] { color: #137333; }
      .actions { display: flex; flex-wrap: wrap; gap: 6px; }
      button {
        border: 1px solid #dadce0;
        border-radius: 7px;
        padding: 6px 9px;
        background: #fff;
        color: #1a73e8;
        cursor: pointer;
        font: inherit;
        font-weight: 600;
      }
      button:hover { background: #f8fafd; }
      button.primary { border-color: #1a73e8; background: #1a73e8; color: #fff; }
      button:disabled { cursor: default; opacity: .5; }
      .note { margin-top: 8px; color: #80868b; font-size: 11px; }
      .preview {
        width: 100%;
        height: 150px;
        box-sizing: border-box;
        margin-top: 8px;
        resize: vertical;
        border: 1px solid #dadce0;
        border-radius: 7px;
        padding: 7px;
        color: #202124;
        font: 12px/1.5 monospace;
      }
      .preview[hidden] { display: none; }
      .history-list {
        display: grid;
        gap: 6px;
        max-height: 210px;
        margin-top: 8px;
        overflow: auto;
      }
      .history-list[hidden] { display: none; }
      .history-item {
        width: 100%;
        border-color: #dadce0;
        color: #202124;
        text-align: left;
        font-weight: 400;
      }
      .history-title, .history-time { display: block; }
      .history-title { font-weight: 700; }
      .history-time { color: #5f6368; font-size: 11px; }
    </style>
    <section class="panel" aria-label="${extensionTitle}">
      <p class="title">${extensionTitle}</p>
      <div class="status" data-active="false">${platform.displayName}の字幕をONにしてから開始してください。</div>
      <div class="actions">
        <button class="primary" data-action="toggle">記録開始</button>
        <button data-action="save" disabled>保存</button>
        <button data-action="history" disabled>履歴</button>
      </div>
      <div class="history-list" hidden aria-label="保存した文字起こし"></div>
      <textarea class="preview" readonly hidden aria-label="保存した文字起こし"></textarea>
      <div class="note">外部送信なし・端末内だけで処理</div>
    </section>
  `;
  document.documentElement.append(host);

  const statusElement = shadow.querySelector(".status");
  const toggleButton = shadow.querySelector('[data-action="toggle"]');
  const saveButton = shadow.querySelector('[data-action="save"]');
  const historyButton = shadow.querySelector('[data-action="history"]');
  const historyListElement = shadow.querySelector(".history-list");
  const previewElement = shadow.querySelector(".preview");

  function getSourceId(element) {
    let sourceId = sourceIdByElement.get(element);
    if (!sourceId) {
      sourceId = `caption-${nextSourceId}`;
      nextSourceId += 1;
      sourceIdByElement.set(element, sourceId);
    }
    return sourceId;
  }

  function findVisibleCaptionElements() {
    for (const selector of CAPTION_SELECTORS) {
      const elements = Array.from(document.querySelectorAll(selector)).filter(
        (element) => element instanceof HTMLElement && element.offsetParent !== null,
      );
      if (elements.length > 0) {
        return elements;
      }
    }
    return [];
  }

  function hasActiveCall() {
    return platform.leaveButtonSelectors.some((selector) => document.querySelector(selector));
  }

  function createTranscriptRecord({ savedAt = new Date().toISOString() } = {}) {
    return {
      id: captureId || savedAt,
      savedAt,
      startedAt: (startedAt || new Date()).toISOString(),
      title: document.title || platform.displayName,
      platform: platform.id,
      text: createTranscriptText(),
    };
  }

  async function checkpointTranscript() {
    if (transcript.lines.length === 0) {
      return;
    }

    const record = createTranscriptRecord();
    await chrome.storage.local.set({
      activeTranscript: {
        ...record,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  function scheduleCheckpoint() {
    window.clearTimeout(checkpointTimer);
    checkpointTimer = window.setTimeout(() => {
      checkpointTimer = null;
      void checkpointTranscript().catch((error) => {
        console.error("会議字幕の仮保存に失敗しました", error);
      });
    }, 500);
  }

  function checkMeetingLifecycle() {
    if (!isCapturing) {
      return;
    }

    if (hasActiveCall()) {
      hadActiveCall = true;
      callMissingSince = null;
      return;
    }

    if (!hadActiveCall) {
      return;
    }

    callMissingSince ||= Date.now();
    if (Date.now() - callMissingSince >= 1500) {
      stopCapture("meeting-ended");
    }
  }

  function scanCaptions() {
    if (!isCapturing) {
      return;
    }

    const visibleElements = findVisibleCaptionElements();
    const currentVisibleSourceIds = new Set();
    let changed = false;

    for (const element of visibleElements) {
      const sourceId = getSourceId(element);
      currentVisibleSourceIds.add(sourceId);
      changed = transcript.upsert(sourceId, element.textContent, new Date()) || changed;
    }

    for (const sourceId of lastVisibleSourceIds) {
      if (!currentVisibleSourceIds.has(sourceId)) {
        transcript.finalize(sourceId);
      }
    }
    lastVisibleSourceIds = currentVisibleSourceIds;

    if (changed || visibleElements.length > 0) {
      statusElement.textContent = `記録中: ${transcript.lines.length} 行`;
    } else if (transcript.lines.length === 0) {
      statusElement.textContent = "記録中。字幕が表示されるのを待っています。";
    }
    saveButton.disabled = transcript.lines.length === 0;
    historyButton.disabled = transcript.lines.length === 0 && !latestTranscriptText;
    if (changed) {
      scheduleCheckpoint();
    }
    checkMeetingLifecycle();
  }

  function startCapture() {
    transcript = new TranscriptStore();
    startedAt = new Date();
    captureId = `${platform.id}:${location.pathname}:${startedAt.toISOString()}`;
    isCapturing = true;
    hadActiveCall = hasActiveCall();
    callMissingSince = null;
    lastVisibleSourceIds = new Set();
    statusElement.dataset.active = "true";
    statusElement.textContent = "記録中。字幕が表示されるのを待っています。";
    toggleButton.textContent = "記録停止";
    saveButton.disabled = true;
    historyButton.disabled = !latestTranscriptText;
    historyListElement.hidden = true;
    previewElement.hidden = true;

    // 字幕は認識途中に同じ要素の文字だけを書き換えるため、子要素の追加だけでなく
    // characterDataも監視する。定期走査は会議サービス側のDOM差し替えを取りこぼさないための補助。
    observer = new MutationObserver(scanCaptions);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    scanTimer = window.setInterval(scanCaptions, 1000);
    scanCaptions();
  }

  function stopCapture(reason = "manual") {
    if (!isCapturing) {
      return;
    }
    isCapturing = false;
    observer?.disconnect();
    observer = null;
    window.clearInterval(scanTimer);
    scanTimer = null;
    window.clearTimeout(checkpointTimer);
    checkpointTimer = null;
    statusElement.dataset.active = "false";
    statusElement.textContent = reason === "meeting-ended"
      ? `会議終了を検知しました: ${transcript.lines.length} 行`
      : `停止しました: ${transcript.lines.length} 行`;
    toggleButton.textContent = "新しく記録";
    if (transcript.lines.length > 0) {
      void checkpointTranscript()
        .then(() => saveTranscript(reason))
        .catch((error) => {
          console.error("会議字幕の終了時保存に失敗しました", error);
          statusElement.textContent = "保存に失敗しました。次回対応サイト起動時に復旧を試みます。";
        });
    }
  }

  function createTranscriptText() {
    return transcript.toText({
      title: document.title || platform.displayName,
      startedAt: startedAt || new Date(),
    });
  }

  async function saveTranscript(reason = "manual") {
    const text = createTranscriptText();
    try {
      const savedAt = new Date().toISOString();
      const record = createTranscriptRecord({ savedAt });
      const stored = await chrome.storage.local.get("transcriptHistory");
      const history = Array.isArray(stored.transcriptHistory)
        ? stored.transcriptHistory
        : [];

      // 無制限に蓄積してブラウザ容量を圧迫しないよう、最新20件だけを端末内に残す。
      // 同じ会議を手動保存しても、会議終了時の自動保存で履歴が重複しないようIDで置き換える。
      await chrome.storage.local.set({
        latestTranscript: record,
        transcriptHistory: [
          record,
          ...history.filter((item) => item?.id !== record.id),
        ].slice(0, 20),
      });
      await chrome.storage.local.remove("activeTranscript");
      latestTranscriptText = text;
      historyButton.disabled = false;
      statusElement.textContent = reason === "meeting-ended"
        ? `会議終了時に自動保存しました: ${transcript.lines.length} 行`
        : `ブラウザ内に保存しました: ${transcript.lines.length} 行`;
    } catch (error) {
      console.error("会議字幕の保存に失敗しました", error);
      statusElement.textContent = "保存に失敗しました。もう一度お試しください。";
    }
  }

  function showTranscriptText(text) {
    if (!text) {
      return;
    }
    previewElement.value = text;
    previewElement.hidden = false;
    previewElement.focus();
    previewElement.select();
    statusElement.textContent = "文字起こしを表示しました。⌘Cでコピーできます。";
  }

  function createHistoryButton(record, { active = false } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";

    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = record.title || "会議";

    const time = document.createElement("span");
    time.className = "history-time";
    const savedAt = record.savedAt || record.updatedAt;
    const savedDate = new Date(savedAt);
    const formattedDate = Number.isNaN(savedDate.getTime())
      ? "保存日時不明"
      : savedDate.toLocaleString("ja-JP");
    time.textContent = active ? `記録中・仮保存 ${formattedDate}` : formattedDate;

    button.append(title, time);
    button.addEventListener("click", () => showTranscriptText(record.text));
    return button;
  }

  async function showHistory() {
    const stored = await chrome.storage.local.get([
      "activeTranscript",
      "transcriptHistory",
    ]);
    const records = [];
    if (typeof stored.activeTranscript?.text === "string") {
      records.push({ record: stored.activeTranscript, active: true });
    }
    const history = Array.isArray(stored.transcriptHistory)
      ? stored.transcriptHistory
      : [];
    for (const record of history) {
      if (typeof record?.text === "string" && record.id !== stored.activeTranscript?.id) {
        records.push({ record, active: false });
      }
    }

    historyListElement.replaceChildren();
    for (const item of records.slice(0, 20)) {
      historyListElement.append(createHistoryButton(item.record, { active: item.active }));
    }
    historyListElement.hidden = false;
    previewElement.hidden = true;
    statusElement.textContent = records.length > 0
      ? "履歴から会議を選んでください。"
      : "保存した文字起こしはありません。";
  }

  toggleButton.addEventListener("click", () => {
    if (isCapturing) {
      stopCapture();
    } else {
      startCapture();
    }
  });
  saveButton.addEventListener("click", () => void saveTranscript());
  historyButton.addEventListener("click", () => {
    void showHistory().catch((error) => {
      console.error("会議字幕の履歴を表示できませんでした", error);
      statusElement.textContent = "履歴を表示できませんでした。";
    });
  });

  async function loadStoredTranscripts() {
    const stored = await chrome.storage.local.get([
      "latestTranscript",
      "activeTranscript",
      "transcriptHistory",
    ]);

    // タブ終了では非同期の正式保存が完了しない場合がある。字幕変更時の仮保存を
    // 次回対応サイト起動時に履歴へ昇格し、閉じた会議の文字起こしを失わないようにする。
    if (typeof stored.activeTranscript?.text === "string") {
      const recovered = {
        ...stored.activeTranscript,
        savedAt: stored.activeTranscript.updatedAt || new Date().toISOString(),
      };
      const history = Array.isArray(stored.transcriptHistory)
        ? stored.transcriptHistory
        : [];
      await chrome.storage.local.set({
        latestTranscript: recovered,
        transcriptHistory: [
          recovered,
          ...history.filter((item) => item?.id !== recovered.id),
        ].slice(0, 20),
      });
      await chrome.storage.local.remove("activeTranscript");
      latestTranscriptText = recovered.text;
      historyButton.disabled = false;
      statusElement.textContent = "前回終了した会議を自動保存しました。";
      return;
    }

    if (typeof stored.latestTranscript?.text === "string") {
      latestTranscriptText = stored.latestTranscript.text;
      historyButton.disabled = false;
    }
  }

  void loadStoredTranscripts().catch((error) => {
    console.error("保存済みの会議字幕を読み込めませんでした", error);
  });

  // pagehideの非同期処理は完了が保証されないため、主な保全は字幕変更時の仮保存で行う。
  // ここでは最後の更新が500msの待機中だった場合だけ、追加の保存機会を与える。
  window.addEventListener("pagehide", () => {
    if (isCapturing && transcript.lines.length > 0) {
      void checkpointTranscript();
    }
  });
})();
