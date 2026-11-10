# Streaming backpressure test

Load this folder with **Load unpacked** at `chrome://extensions` in your modified
Chromium build. Click the extension's toolbar action to open the test in a tab,
then click **Run backpressure test**. Keep the tab open and avoid manually
pausing/resuming that download during the test. No Chromium rebuild is needed
to load this test against the existing implementation.

The default run writes 64 MiB in 1 MiB chunks, allocating one chunk at a time.
You can choose 256 KiB or 4 MiB chunks, and totals up to 4096 MiB for longer
memory observations. All chunk choices exceed the current 64 KiB Mojo pipe.

The test first writes a warmup chunk and waits for download progress. It then
performs three cycles:

1. Pause the download through `chrome.downloads.pause`, confirm its paused state,
   and allow one second for the asynchronous file-consumer pause to take effect.
2. Submit a chunk and observe it for three seconds. Its write promise must stay
   pending; an API rejection is a failure, not evidence of backpressure.
3. Resume the consumer. The pending write must complete within 30 seconds.

Finally, stream the remaining bytes, close the stream, wait for native download
completion, and check `totalBytes` and `bytesReceived` by download ID. A successful
file remains in Downloads; failure or the Cancel test button cancels the download.

In this Chromium source, `DownloadJob::Pause` posts `DownloadFile::Pause` to the
download sequence. `DownloadFileImpl::Pause` disables stream-read notifications,
and `StreamActive` returns while paused. The producer's writable watcher should
therefore wait when the pipe fills and recover when the consumer resumes.

This is an integration test with observation windows, not direct pipe-occupancy
instrumentation. Timing and external interference can affect results. PASS
provides evidence of producer blocking and recovery, not proof of an exact
64 KiB total memory limit or absence of every other buffer. For exact limits,
use a lower-level controlled-consumer test. Saved contents are not read back.
Use Chromium Task Manager or Windows process-memory counters for a separate
memory-growth check. Canceling/closing a tab is not a guaranteed session cleanup
test; use the Cancel test button and keep the tab open until it finishes.

This is a separate extension. Existing extensions and saved 1.0 tags are unchanged.
