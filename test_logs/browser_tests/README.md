# Browser-test evidence

The recorded Windows run passed all 12 `StreamingDownloadLifecycleTest` tests
in 73 seconds.

- `browser_tests.log.txt`: test names, individual results, and final summary.
- `browser_diagnostics.log.txt`: Chromium diagnostic output from the run.

To rerun after building `browser_tests`, use PowerShell from the Chromium source
directory:

```powershell
.\out\Default\browser_tests.exe --gtest_filter="StreamingDownloadLifecycleTest.*" > browser_tests.log.txt 2> browser_diagnostics.log.txt
```

These tests cover binary contents, extension ownership, overlapping calls,
filename validation, empty files, pause/resume, cancellation, extension unload,
interruption, and download destruction. Their implementation is included in
`../../patches/0003-Fix-streaming-download-lifecycle-and-add-regression-coverage.patch`.
