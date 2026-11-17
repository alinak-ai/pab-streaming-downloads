# download unknown file

A Manifest V3 extension running the assignment's streaming download benchmark.

## Run the benchmark

1. Start the Chromium build containing the streaming download APIs.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select this `downloads_api_extension` folder.
   If already loaded, click **Reload** on its extension card.
4. Open the extension popup. For long runs, click **Open benchmark in a tab**.
5. Click **Run benchmark** and keep the page open until it reports a result.
6. Open `chrome://downloads/` to see the generated file.

The benchmark generates 100 MiB of deterministic data in 4 KiB chunks using
promise calls to `streamDownloadStart`, `streamDownloadWrite`, and
`streamDownloadFinish`. After the stream finishes, the page waits up to two
minutes for the download to complete, then verifies its state and reported size.
This does not verify the saved file's contents.

`popup.html` loads `benchmark.js`. The assignment's `runBenchmark()` and
`verifyDownload()` functions are preserved unchanged; UI and completion handling
are appended below them. The URL and selected-file demo is in the separate
`../named_file_download_extension/` folder, which contains its own `popup.js`.

The extension requests only the `downloads` permission.

The separate **downloade named file** extension in `../named_file_download_extension`
loads the original popup demo. Load both folders independently at `chrome://extensions`.
