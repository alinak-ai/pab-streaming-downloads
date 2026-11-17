"use strict";

// No payloads are logged or retained in the result objects.
window.runnerStatus = {phase: "ready", done: false, cases: []};
window.abortRun = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const inspect = async id => (await chrome.downloads.search({id}))[0];

// Absolute-position pattern; the Python verifier implements it independently.
function fillChunk(bytes, offset) {
  for (let i = 0; i < bytes.length; ++i) {
    const position = offset + i;
    const block = Math.floor(position / 65536);
    bytes[i] = (31 * position + 17 * block +
                53 * Math.floor(block / 256) +
                97 * Math.floor(block / 65536)) & 255;
  }
}

window.startRun = function(config) {
  if (window.runnerStatus.phase !== "ready") throw new Error("Already started");
  for (const name of ["streamDownloadStart", "streamDownloadWrite", "streamDownloadFinish"]) {
    if (typeof chrome.downloads[name] !== "function") {
      throw new Error(`${name} is unavailable; launch the patched Chromium build`);
    }
  }
  window.runnerStatus.phase = "starting";
  run(config).catch(error => {
    Object.assign(window.runnerStatus, {phase: "failed", error: String(error), done: true});
  });
  return true;
};

async function run(config) {
  const status = window.runnerStatus;
  for (let caseIndex = 0; caseIndex < config.sizesMiB.length; ++caseIndex) {
    const total = config.sizesMiB[caseIndex] * 1024 * 1024;
    const result = {caseIndex, requestedBytes: total, chunkBytes: config.chunkBytes,
                    pauseSeconds: config.pauseSeconds, pauseSnapshots: [],
                    writesCompleted: 0, peakPendingWrites: 0,
                    peakSubmittedChunkBytes: 0, maximumWriteWaitMs: 0};
    status.cases.push(result);
    Object.assign(status, {caseIndex, phase: "starting", sentBytes: 0, progress: null});
    const id = await chrome.downloads.streamDownloadStart({
      filename: `stream-measure-${config.runId}-${caseIndex}.bin`
    });
    result.id = id;
    status.activeId = id;
    result.initial = await inspect(id);
    if (!Number.isInteger(id) || result.initial?.state !== "in_progress" ||
        result.initial.bytesReceived !== 0 || result.initial.totalBytes > 0) {
      try { await chrome.downloads.cancel(id); } catch (_) { /* terminal */ }
      throw new Error("Expected a real in-progress download with no bytes and unknown size at Start");
    }
    let completedAt = null;
    const onChanged = delta => {
      if (delta.id === id && delta.state?.current === "complete") completedAt = performance.now();
    };
    chrome.downloads.onChanged.addListener(onChanged);
    let polling = false;
    async function update() {
      if (polling) return;
      polling = true;
      try { status.progress = await inspect(id); }
      catch (error) { status.progressError = String(error); }
      finally { polling = false; }
    }
    const timer = setInterval(update, 500);
    try {
      let sent = 0;
      let paused = false;
      const chunk = new Uint8Array(Math.min(config.chunkBytes, total));
      const began = performance.now();
      while (sent < total) {
        if (window.abortRun) throw new Error("Stopped by runner");
        status.phase = "generating";
        const bytes = total - sent < chunk.length ? new Uint8Array(total - sent) : chunk;
        fillChunk(bytes, sent);
        result.peakPendingWrites = 1;
        result.peakSubmittedChunkBytes = Math.max(result.peakSubmittedChunkBytes, bytes.length);
        const writeBegan = performance.now();
        await chrome.downloads.streamDownloadWrite(id, bytes.buffer);
        result.maximumWriteWaitMs = Math.max(result.maximumWriteWaitMs, performance.now() - writeBegan);
        ++result.writesCompleted;
        sent += bytes.length;
        status.sentBytes = sent;
        if (!paused && sent >= total / 2 && sent < total) {
          paused = true;
          status.phase = "producer-pause";
          result.pauseStartedMs = performance.now() - began;
          result.pauseSnapshots.push(await inspect(id));
          const end = performance.now() + config.pauseSeconds * 1000;
          while (performance.now() < end) {
            if (window.abortRun) throw new Error("Stopped by runner");
            await sleep(Math.min(500, Math.max(0, end - performance.now())));
            const item = await inspect(id);
            result.pauseSnapshots.push(item);
            if (!item || item.state !== "in_progress") throw new Error("Download stopped during producer pause");
          }
          result.actualPauseMs = performance.now() - began - result.pauseStartedMs;
        }
        if (config.delayMs) await sleep(config.delayMs);
      }
      status.phase = "finishing";
      const finishStarted = performance.now();
      await chrome.downloads.streamDownloadFinish(id);
      const finishResolved = performance.now();
      // No artificial wait here: this is the first search after Finish resolves.
      result.immediateAfterFinish = await inspect(id);
      result.finishCallMs = finishResolved - finishStarted;
      result.finishObservation = result.immediateAfterFinish?.state === "in_progress"
          ? "EARLY_FINISH_OBSERVED" : "NO_EARLY_FINISH_OBSERVED_NOT_A_GUARANTEE";
      status.phase = "awaiting-completion";
      const deadline = performance.now() + config.completionTimeoutSeconds * 1000;
      let item = result.immediateAfterFinish;
      while (item?.state !== "complete") {
        if (window.abortRun) throw new Error("Stopped by runner");
        if (!item || item.state === "interrupted") throw new Error(`Download failed: ${item?.error}`);
        if (performance.now() > deadline) throw new Error("Completion timed out");
        await sleep(50);
        item = await inspect(id);
      }
      result.final = item;
      result.completeEventRelativeToFinishMs = completedAt === null ? null : completedAt - finishResolved;
      result.elapsedMs = performance.now() - began;
      if (item.totalBytes !== total || item.bytesReceived !== total) throw new Error("Final byte count mismatch");
      result.status = "PASS";
    } catch (error) {
      result.status = "FAIL";
      result.error = String(error);
      try { await chrome.downloads.cancel(id); } catch (_) { /* already terminal */ }
      throw error;
    } finally {
      clearInterval(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      status.activeId = null;
    }
  }
  Object.assign(status, {phase: "done", done: true});
}

setInterval(() => {
  const {phase, sentBytes, caseIndex, error} = window.runnerStatus;
  document.querySelector("#status").textContent = JSON.stringify({phase, caseIndex, sentBytes, error}, null, 2);
}, 500);
