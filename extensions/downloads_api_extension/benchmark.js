// Example: Stream 100MB of deterministic data to disk.
async function runBenchmark() {
  const filename = `benchmark_${Date.now()}.bin`;
  const targetSize = 100 * 1024 * 1024; // 100MB
  let bytesWritten = 0;
  let chunkIndex = 0;

  const download = await chrome.downloads.streamDownloadStart({ filename });

  while (bytesWritten < targetSize) {
    const chunkSize = Math.min(4096, targetSize - bytesWritten);
    const chunk = new Uint8Array(chunkSize);
    for (let i = 0; i < chunk.length; ++i) {
      chunk[i] = (chunkIndex + i) & 0xff;
    }

    await chrome.downloads.streamDownloadWrite(download, chunk.buffer);

    bytesWritten += chunkSize;
    ++chunkIndex;
  }

  await chrome.downloads.streamDownloadFinish(download);
  console.log('Download is done');

  return { filename, expectedSize: bytesWritten };
}

// Verify the download completed successfully via chromium's downloads API
async function verifyDownload(filename, expectedSize) {
  return new Promise((resolve) => {
    chrome.downloads.search({}, (results) => {
      const download = results.find(d => d.filename.endsWith(filename));
      if (!download) {
        resolve({ success: false, error: 'Download not found in chrome.downloads' });
      } else if (download.state !== 'complete') {
        resolve({ success: false, error: `Download state: ${download.state}` });
      } else if (download.totalBytes !== expectedSize) {
        resolve({ success: false, error: `Size mismatch: expected ${expectedSize}, got ${download.totalBytes}` });
      } else {
        resolve({ success: true });
      }
    });
  });
}

// Wait for Chromium to finish saving after the benchmark closes its stream.
async function waitForDownloadComplete(filename) {
  const deadline = Date.now() + 120000;
  while (true) {
    const downloads = await chrome.downloads.search({});
    const download = downloads.find(d => d.filename.endsWith(filename));
    if (!download) throw new Error('Download not found in chrome.downloads');
    if (download.state === 'complete') return;
    if (download.state === 'interrupted') {
      throw new Error(`Download interrupted: ${download.error || 'Unknown error'}`);
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for completion. Check chrome://downloads.');
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

const benchmarkButton = document.querySelector('#run-benchmark');
const benchmarkStatus = document.querySelector('#status');

benchmarkButton.addEventListener('click', async () => {
  benchmarkButton.disabled = true;
  try {
    benchmarkStatus.textContent = 'Streaming 100 MiB in 4 KiB chunks…';
    const { filename, expectedSize } = await runBenchmark();
    benchmarkStatus.textContent = 'Stream sent. Waiting for the download to complete…';
    await waitForDownloadComplete(filename);
    const result = await verifyDownload(filename, expectedSize);
    if (!result.success) throw new Error(result.error);
    benchmarkStatus.textContent =
        `Verified: ${filename} (${expectedSize} bytes). Download complete.`;
  } catch (error) {
    benchmarkStatus.textContent = `Benchmark failed: ${error.message}`;
  } finally {
    benchmarkButton.disabled = false;
  }
});
