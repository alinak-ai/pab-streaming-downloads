const runButton = document.querySelector('#run');
const stopButton = document.querySelector('#stop');
const totalInput = document.querySelector('#total');
const chunkInput = document.querySelector('#chunk');
const statusText = document.querySelector('#status');
const logText = document.querySelector('#log');
const progress = document.querySelector('#progress');
let activeController;

function log(message) {
  logText.textContent += `${new Date().toLocaleTimeString()} ${message}\n`;
}

// Bounds waits without pretending that timing out cancels the underlying API.
// The caller cancels the download on any failure, which closes its consumer.
function bounded(promise, signal, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('Test canceled'));
    };
    if (signal.aborted) {
      // The API call may already have started when cancellation arrived.
      Promise.resolve(promise).catch(() => {});
      reject(new Error('Test canceled'));
      return;
    }
    signal.addEventListener('abort', onAbort, {once: true});
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out: ${description}`));
    }, timeoutMs);
    Promise.resolve(promise).then(value => {
      cleanup();
      resolve(value);
    }, error => {
      cleanup();
      reject(error);
    });
  });
}

function delay(ms, signal) {
  return bounded(new Promise(resolve => setTimeout(resolve, ms)), signal,
      ms + 10000, 'waiting for observation period');
}

async function itemFor(id, signal) {
  const items = await bounded(chrome.downloads.search({id}), signal, 10000,
      'reading download state');
  if (!items.length) throw new Error(`Download ${id} not found`);
  if (items[0].state === 'interrupted') {
    throw new Error(`Download interrupted: ${items[0].error || 'unknown reason'}`);
  }
  return items[0];
}

async function waitFor(id, predicate, signal, description) {
  const deadline = performance.now() + 120000;
  while (performance.now() < deadline) {
    const item = await itemFor(id, signal);
    if (predicate(item)) return item;
    await delay(200, signal);
  }
  throw new Error(`Timed out: ${description}`);
}

function makeChunk(size, offset) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; ++i) {
    // Include position above the low byte so adjacent chunks differ, too.
    const position = offset + i;
    bytes[i] = (position ^ (position >>> 8) ^ (position >>> 16) ^
        (Math.floor(position / 16777216) & 255)) & 255;
  }
  return bytes.buffer;
}

stopButton.addEventListener('click', () => activeController?.abort());

runButton.addEventListener('click', async () => {
  const totalMiB = Number(totalInput.value);
  if (!Number.isInteger(totalMiB) || totalMiB < 16 || totalMiB > 4096) {
    statusText.textContent = 'Choose a total size from 16 to 4096 MiB.';
    return;
  }
  const chunkSize = Number(chunkInput.value);
  const totalSize = totalMiB * 1024 * 1024;
  const controller = new AbortController();
  activeController = controller;
  const {signal} = controller;
  let downloadId;
  let bytesWritten = 0;
  logText.textContent = '';
  runButton.disabled = totalInput.disabled = chunkInput.disabled = true;
  stopButton.disabled = false;
  progress.max = totalSize;
  progress.value = 0;
  const started = performance.now();

  try {
    for (const name of ['streamDownloadStart', 'streamDownloadWrite', 'streamDownloadFinish']) {
      if (typeof chrome.downloads[name] !== 'function') {
        throw new Error(`Missing ${name}. Use the modified Chromium build.`);
      }
    }
    const filename = `backpressure_${Date.now()}.bin`;
    statusText.textContent = 'Starting download and warming up the file consumer...';
    // Track a late start response, so cancellation cannot orphan its download.
    const start = chrome.downloads.streamDownloadStart({filename}).then(id => {
      downloadId = id;
      if (signal.aborted) {
        chrome.downloads.cancel(id).catch(error => log(`Cancel failed: ${error.message}`));
      }
      return id;
    });
    downloadId = await bounded(start, signal, 30000, 'starting stream');
    log(`Download ID ${downloadId}; ${totalMiB} MiB total; ${chunkSize} bytes per chunk.`);

    const writeNext = async () => {
      const size = Math.min(chunkSize, totalSize - bytesWritten);
      await bounded(chrome.downloads.streamDownloadWrite(downloadId,
          makeChunk(size, bytesWritten)), signal, 30000, 'writing chunk');
      bytesWritten += size;
      progress.value = bytesWritten;
    };
    await writeNext();
    await waitFor(downloadId, item => item.bytesReceived >= bytesWritten,
        signal, 'waiting for the file consumer to read the warmup chunk');

    for (let cycle = 1; cycle <= 3; ++cycle) {
      statusText.textContent = `Cycle ${cycle}/3: pausing consumer...`;
      await bounded(chrome.downloads.pause(downloadId), signal, 10000, 'pausing');
      await waitFor(downloadId, item => item.paused, signal, 'confirming pause');
      // Pause is posted to the download sequence. Allow it time to take effect.
      await delay(1000, signal);
      const size = Math.min(chunkSize, totalSize - bytesWritten);
      let settled = false;
      let writeError;
      const writeStarted = performance.now();
      const write = chrome.downloads.streamDownloadWrite(downloadId,
          makeChunk(size, bytesWritten)).then(() => {
        settled = true;
      }, error => {
        settled = true;
        writeError = error;
      });
      statusText.textContent = `Cycle ${cycle}/3: checking write stays pending for 3 seconds...`;
      await delay(3000, signal);
      const pausedItem = await itemFor(downloadId, signal);
      if (!pausedItem.paused) throw new Error('Download was resumed externally; test invalid.');
      if (writeError) throw writeError;
      if (settled) {
        throw new Error(`Cycle ${cycle}: write completed while the consumer was paused. Expected backpressure was not observed.`);
      }
      log(`Cycle ${cycle}: PASS - ${size}-byte write remained pending while paused.`);
      await bounded(chrome.downloads.resume(downloadId), signal, 10000, 'resuming');
      await bounded(write, signal, 30000, 'write completing after resume');
      if (writeError) throw writeError;
      bytesWritten += size;
      progress.value = bytesWritten;
      log(`Cycle ${cycle}: PASS - write completed after resume (${Math.round(performance.now() - writeStarted)} ms total).`);
    }

    statusText.textContent = 'Streaming remaining data...';
    let lastLogged = bytesWritten;
    while (bytesWritten < totalSize) {
      await writeNext();
      if (bytesWritten - lastLogged >= 8 * 1024 * 1024) {
        log(`Accepted ${bytesWritten} / ${totalSize} bytes.`);
        lastLogged = bytesWritten;
      }
    }
    await bounded(chrome.downloads.streamDownloadFinish(downloadId), signal,
        30000, 'closing stream');
    statusText.textContent = 'Waiting for download completion...';
    const item = await waitFor(downloadId, item => item.state === 'complete',
        signal, 'waiting for final completion');
    if (item.totalBytes !== totalSize || item.bytesReceived !== totalSize) {
      throw new Error(`Size mismatch: expected ${totalSize}; totalBytes=${item.totalBytes}, bytesReceived=${item.bytesReceived}`);
    }
    log(`PASS - download complete; ${totalSize} bytes; ${item.filename}`);
    statusText.textContent = `PASS: three pause/resume cycles and final size verified (${((performance.now() - started) / 1000).toFixed(1)} seconds).`;
  } catch (error) {
    controller.abort();
    log(`Stopped: ${error.message}`);
    statusText.textContent = `Test stopped: ${error.message}`;
    if (downloadId !== undefined) {
      try {
        await chrome.downloads.cancel(downloadId);
        log('Canceled test download.');
      } catch (cancelError) {
        log(`Cancel failed: ${cancelError.message}. Cancel it in chrome://downloads.`);
      }
    }
  } finally {
    activeController = undefined;
    runButton.disabled = totalInput.disabled = chunkInput.disabled = false;
    stopButton.disabled = true;
  }
});
