const form = document.querySelector("#download-form");
const urlInput = document.querySelector("#url");
const filenameInput = document.querySelector("#filename");
const status = document.querySelector("#status");
const streamForm = document.querySelector("#stream-form");
const streamFileInput = document.querySelector("#stream-file");
const streamFilenameInput = document.querySelector("#stream-filename");
const streamStatus = document.querySelector("#stream-status");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  status.textContent = "Starting download…";

  let url;
  try {
    url = new URL(urlInput.value.trim());
  } catch {
    status.textContent = "Enter a valid file URL.";
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    status.textContent = "Use an HTTP or HTTPS URL.";
    return;
  }

  const options = { url: url.href, saveAs: true };
  const filename = filenameInput.value.trim();
  if (filename) options.filename = filename;

  chrome.downloads.download(options, (downloadId) => {
    if (chrome.runtime.lastError) {
      status.textContent = `Download failed: ${chrome.runtime.lastError.message}`;
      return;
    }
    status.textContent = `Download started (ID ${downloadId}).`;
  });
});

function callDownloadsApi(method, ...args) {
  return new Promise((resolve, reject) => {
    method(...args, result => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve(result);
      }
    });
  });
}

streamForm.addEventListener("submit", async event => {
  event.preventDefault();
  const file = streamFileInput.files[0];
  if (!file) {
    streamStatus.textContent = "Choose a file to stream.";
    return;
  }

  let filename = streamFilenameInput.value.trim() || file.name;
  const sourceExtension = /\.[^.]+$/.exec(file.name);
  const outputBasename = filename.split(/[\\/]/).pop();
  if (sourceExtension && !/\.[^.]+$/.test(outputBasename)) {
    filename += sourceExtension[0];
  }
  const totalBytes = file.size;
  const chunkSize = 64 * 1024;
  const submitButton = streamForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  let downloadId;
  try {
    streamStatus.textContent = `Starting stream of ${file.name} (${totalBytes} bytes)…`;
    downloadId = await callDownloadsApi(
        chrome.downloads.streamDownloadStart.bind(chrome.downloads), {filename});
    for (let offset = 0; offset < totalBytes; offset += chunkSize) {
      const length = Math.min(chunkSize, totalBytes - offset);
      const chunk = await file.slice(offset, offset + length).arrayBuffer();
      await callDownloadsApi(
          chrome.downloads.streamDownloadWrite.bind(chrome.downloads),
          downloadId, chunk);
      streamStatus.textContent =
          `Streaming ${Math.min(offset + length, totalBytes)} / ${totalBytes} bytes…`;
    }
    await callDownloadsApi(
        chrome.downloads.streamDownloadFinish.bind(chrome.downloads), downloadId);
    streamStatus.textContent =
        `Stream finished: ${filename} (${totalBytes} bytes, download ID ${downloadId}).`;
  } catch (error) {
    if (downloadId !== undefined) {
      try {
        await callDownloadsApi(chrome.downloads.cancel.bind(chrome.downloads), downloadId);
      } catch {
        // Keep the original read or write error visible.
      }
    }
    streamStatus.textContent = `Stream failed: ${error.message}`;
  } finally {
    submitButton.disabled = false;
  }
});
