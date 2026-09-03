(function initializeCaptureCore(globalScope) {
  "use strict";

  function normalizeCaption(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function formatTime(value) {
    return new Intl.DateTimeFormat("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(value);
  }

  function isSameUtterance(previousText, nextText) {
    if (previousText.includes(nextText) || nextText.includes(previousText)) {
      return true;
    }

    // Meetは認識途中の単語を後から修正する。先頭部分がある程度同じなら、
    // 新しい発言を増やさず同じ字幕行の訂正として扱う。
    const shorterLength = Math.min(previousText.length, nextText.length);
    let commonPrefixLength = 0;
    while (
      commonPrefixLength < shorterLength &&
      previousText[commonPrefixLength] === nextText[commonPrefixLength]
    ) {
      commonPrefixLength += 1;
    }

    return shorterLength > 0 && commonPrefixLength / shorterLength >= 0.4;
  }

  class TranscriptStore {
    constructor() {
      this.lines = [];
      this.activeLineBySource = new Map();
    }

    upsert(sourceId, value, capturedAt = new Date()) {
      const text = normalizeCaption(value);
      if (!text) {
        return false;
      }

      const activeLineIndex = this.activeLineBySource.get(sourceId);
      if (activeLineIndex !== undefined) {
        const activeLine = this.lines[activeLineIndex];
        if (activeLine.text === text) {
          return false;
        }
        if (isSameUtterance(activeLine.text, text)) {
          activeLine.text = text;
          return true;
        }
      }

      // Meetが同じDOM要素を次の発言へ再利用する場合がある。
      // 内容が連続していなければ以前の行を残し、新しい発言として追加する。
      const lastLine = this.lines.at(-1);
      if (lastLine && lastLine.text === text) {
        this.activeLineBySource.set(sourceId, this.lines.length - 1);
        return false;
      }

      this.lines.push({ capturedAt: new Date(capturedAt), text });
      this.activeLineBySource.set(sourceId, this.lines.length - 1);
      return true;
    }

    finalize(sourceId) {
      this.activeLineBySource.delete(sourceId);
    }

    toText({ title = "Google Meet", startedAt = new Date() } = {}) {
      const header = [
        `会議: ${title}`,
        `記録開始: ${startedAt.toLocaleString("ja-JP")}`,
        "",
      ];
      const body = this.lines.map(
        (line) => `[${formatTime(line.capturedAt)}] ${line.text}`,
      );
      return [...header, ...body, ""].join("\n");
    }
  }

  const api = { TranscriptStore, isSameUtterance, normalizeCaption };
  globalScope.MeetTranscriptCapture = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis === "undefined" ? window : globalThis);
