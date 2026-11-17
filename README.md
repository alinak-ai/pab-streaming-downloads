# Chromium Streaming Downloads

An extension API for streaming file bytes into Chromium's native download system without requiring a download URL or knowing the total size upfront.

## Contents

- `patches/`: Chromium implementation and API test changes.
- `extensions/downloads_api_extension/`: Generated-data benchmark.
- `extensions/named_file_download_extension/`: URL and selected-file download demo.
- `extensions/backpressure_test_extension/`: Pause/resume backpressure test.
- `memory_bound_test/`: Python-driven three-file transfer, integrity, and memory test.
- `test_logs/browser_tests/`: Recorded C++ browser-test output.
- `test_logs/python/`: Recorded three-file Python test output and memory measurements.
- `scripts/apply-patches.ps1`: Applies all three Chromium patches in order.
- `version-manifest.json`: Required source and tool revisions.

The first Chromium patch comes from the saved `streaming-downloads-1.0` implementation.
The second replaces an unsafe raw-pointer copy with a bounds-checked byte-span copy
so the implementation can compile with unsafe-buffer warnings treated as errors.
The third fixes session cleanup and pending writes when downloads are cancelled,
interrupted, or destroyed, or their extension unloads. It adds browser regression
tests for lifecycle handling, binary content integrity, ownership, backpressure,
invalid filenames, and overlapping calls. The package also includes test extensions developed afterward.

## Prerequisites

Use Chromium version `138.0.7204.49`, base commit:

`d2b48fd5f7813ed477a2d68fa232b8178fa4fb1e`

Prepare the checkout, dependencies, depot_tools, and Windows development tools using Chromium's instructions:

https://chromium.googlesource.com/chromium/src/+/138.0.7204.49/docs/windows_build_instructions.md

Check out the specified revision and sync its dependencies before applying the patch. Having only Chromium's source files is insufficient for building it.

## Apply the implementation

Keep this project outside your Chromium source directory.

From this project's root, run the following in PowerShell, substituting your Chromium source path:

```powershell
.\scripts\apply-patches.ps1 -ChromiumSrc "C:\Work\chromium\src"
```

The script requires the exact base commit and no modified tracked files. It applies all three patches in order and creates local Git commits.

Git needs a configured author name and email for that commit.

## Build Chromium

Follow Chromium's standard Windows build instructions after applying the patch.

If you already built the required baseline, rebuild after applying the patch. The build system will rebuild the affected parts.

## Load the extensions

Start the newly built Chromium, preferably with a separate development profile.

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked for each of the three folders inside `extensions/`.
4. Open the desired extension from the toolbar.

For the benchmark and named-file demo, open the interface in a tab before starting a transfer. Closing the popup can stop its JavaScript.

The backpressure extension opens directly in a tab.

## Streaming API

```javascript
const id = await chrome.downloads.streamDownloadStart({
  filename: "example.bin"
});

await chrome.downloads.streamDownloadWrite(id, arrayBuffer);
await chrome.downloads.streamDownloadFinish(id);
```

Callback-style calls are also supported.

Await each write before submitting the next chunk. Write completion acknowledges transfer into the download pipeline, not a per-chunk disk flush.

Finish closes the stream. Observe the download's native `complete` state to confirm final completion.

## Tests and limitations

The generated-data benchmark checks download completion and reported size.

The backpressure test pauses the download consumer, checks that a large write stays pending, resumes the consumer, and checks that the write completes.

This test does not prove bounded memory for an independent producer that ignores write completion. It also does not measure total process memory.

The three demo extensions do not automatically verify the saved file contents. Patch 0003
adds native browser tests that verify binary content and failure paths. Run them
after building `browser_tests`:

```sh
out/Default/browser_tests.exe --gtest_filter="StreamingDownloadLifecycleTest.*"
```

The recorded Windows run passed all 12 `StreamingDownloadLifecycleTest` tests
in 73 seconds. Output and diagnostics are in [test_logs/browser_tests](test_logs/browser_tests/README.md).

The separate [Python test](memory_bound_test/README.md) downloads three files
sequentially: 64 MiB, 1 GiB, and 4 GiB. It pauses production for 20 seconds
halfway through each file, records process memory, waits for native completion,
and independently verifies each saved byte. All three files passed in the
[recorded run](test_logs/python/README.md). These producer pauses test gaps in
input, separately from the paused-consumer backpressure extension.

## Excluded files

Chromium source and binaries, depot_tools, browser profiles, caches, generated
downloads, raw test-result directories, and large test videos are not distributed
in this repository.
Selected submission logs and memory measurements are included in `test_logs/`.
The analysis document is supplied separately.

## Updating a checkout that already has the first patch

Do not reapply the first patch or rerun the baseline-only apply script.
From your Chromium source directory, apply only the fix (substitute your project path):

```sh
git am /path/to/pab-streaming-downloads/patches/0002-Fix-unsafe-buffer-copy-in-streaming-downloads.patch
```

Then rebuild using the normal Chromium build instructions. Keep compiler safety
checks enabled. To explicitly treat enabled compiler warnings as errors, use
`treat_warnings_as_errors = true` in your build directory's `args.gn`.
This maps to `-Werror` on Linux and `/WX` on Windows; it does not enable every
possible warning or remove Chromium's existing warning exceptions.

## Updating a checkout that already has patches 0001 and 0002

Apply only the lifecycle fix from your Chromium source directory:

```sh
git am /path/to/pab-streaming-downloads/patches/0003-Fix-streaming-download-lifecycle-and-add-regression-coverage.patch
```

If only patch 0001 is installed, apply patch 0002 first, then patch 0003.
Rebuild `chrome` and `browser_tests` and run the lifecycle tests above.
Version tag: `streaming-downloads-1.3`.
