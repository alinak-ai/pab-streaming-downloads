# Automated streaming download measurements

This isolated test package does not modify Chromium or the other test extensions.
Run one Python command; it launches the existing patched Chromium, creates a new
profile, loads the included extension, drives it through Chromium's local debugging
interface, samples process memory, verifies downloads, and closes its own browser.
It does not use native messaging, a file-serving HTTP server, or a persistent daemon.
The debugging connection uses a dynamically selected local port.

## Run

On Windows, open PowerShell and create a local Python environment:

```powershell
cd C:\ChromeSrc\pab-streaming-downloads\memory_bound_test
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Run the submitted test: three separate files of 64 MiB, 1 GiB, and 4 GiB:

```powershell
.\.venv\Scripts\python.exe run_streaming_tests.py --chromium "C:\ChromeSrc\chromium\src\out\Default\chrome.exe" --sizes-mib 64 1024 4096 --pause-seconds 20 --timeout-seconds 3600
```

No manual extension loading or virtual-environment activation is needed. Results
are saved under this folder's `results` directory. Windows does not provide PSS;
RSS and available USS measurements are still recorded.

On Linux, from the `memory_bound_test` folder, create an environment and supply
the path to your patched Chromium binary:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python run_streaming_tests.py --chromium /path/to/patched/chrome --sizes-mib 64 1024 4096 --pause-seconds 20 --timeout-seconds 3600
```

Matplotlib creates the memory PNG. If it is unavailable, CSV/JSON measurements
are still recorded.

The submitted test downloads 64 MiB, 1 GiB, and 4 GiB files sequentially, using
1 MiB chunks, a 5 ms delay after each chunk, and a 20-second producer pause
halfway through each file. No total size is passed to Start. Each Write is
awaited; only one is pending at a time. The command allows up to one hour
and requires about 5.6 GiB of free disk space including headroom.

Use `--delay-ms 20` for longer observation windows, `--chunk-kib 256` for smaller
chunks, or `--chromium /absolute/path/to/chrome` for another build. All cases in a
run use the same configured chunk size. The runner checks free disk space first.
A pause needs at least two chunks: if a case fits in one chunk, no halfway pause
is possible and `pauseSnapshots` is empty. Use `--help` for all options.

The browser runs headlessly, so no window appears. Your normal browser can remain
open because this run has its own profile. Run the command as your normal user.
Ctrl+C stops the run and closes its test browser; interrupted results are recorded.

## Output and interpretation

Every run creates a fresh `results/<UTC timestamp>/` directory:

- `REPORT.md`: readable transfer, Finish-timing, verification, and memory summary.
- `results.json`: configuration, exact browser version, browser-reported revision,
  checkout HEAD (when discoverable), detailed API results, hashes, and memory peaks.
  Checkout HEAD is not proof that a particular binary was built from that HEAD.
- `memory.csv`: one row per process per sample: PID, role, RSS, PSS, USS, phase,
  and application byte count. Sampling defaults to once per second.
- `memory.png`: RSS and PSS over time by process role, when matplotlib is available.
- `progress.json`: sampled native state/counters and `.crdownload` size observations.
- `live-status.json`: latest extension status, useful while a run is active.
- `browser.log`: Chromium's diagnostic output.
- `downloads/`: completed files, retained for independent checking.

The temporary profile lives inside the run directory and is removed after the
browser exits. `--keep-profile` preserves it for inspection. Results and completed
downloads are retained; delete an old run directory yourself when no longer needed.
Do not reuse a results directory: `--output` must identify a new directory.

`PASS` means the transfer, initial empty-download check, pause-state checks (when
performed), final byte counts, and independent file verification passed. It does
not mean Finish waits for completion or memory is proven constant.

### Finish timing

The extension searches the DownloadItem immediately after Finish resolves, with no
added completion wait. `EARLY_FINISH_OBSERVED` is evidence that Finish returned
before native completion. A completed state is labelled
`NO_EARLY_FINISH_OBSERVED_NOT_A_GUARANTEE`: completion can race the search response.
The runner then waits separately for completion to safely verify the output.
Event timing is recorded too, but JavaScript event delivery is not a precise
timestamp of the underlying C++ state transition.

### Memory

`browser` measures the main process. `extension_renderer` measures renderers carrying
`--extension-process`; this isolated run loads one extension with no background
worker, and its producer is a normal extension tab. Other renderer, GPU, utility,
zygote, and broker processes are recorded separately. Inspect `memory.csv` to
confirm which processes exist rather than assuming an extension renderer was found.

RSS includes shared pages and summing RSS across processes can double-count them.
PSS apportions shared pages; USS counts private pages. PSS/USS may be unavailable
due to process permissions and are recorded as missing. The Python runner, verifier,
and Linux filesystem page cache are not counted as browser-process memory.

Compare trends at fixed chunk size as file size increases. A plateau supports
bounded behavior over the observed run; sustained growth proportional to output is
suspicious. Startup, garbage collection, and retained allocations affect endpoints.
No arbitrary automatic constant-memory PASS threshold is used. Application counters
such as one pending Write are separate from measured process memory. Short runs may
miss partial-file growth or transient memory peaks between samples.

### File contents

The pattern is defined by absolute byte position `p`, with `b = floor(p / 65536)`:

```text
(31*p + 17*b + 53*floor(b/256) + 97*floor(b/65536)) & 255
```

The JavaScript producer and Python verifier implement this independently. Python
compares every byte using 64 KiB blocks and computes actual/expected SHA-256 hashes;
it never constructs a complete reference file. Verify again manually with:

```bash
python3 verify_file.py /absolute/path/from/results.json --expected-bytes 1073741824
```

## File purposes and remaining checks

- `run_streaming_tests.py`: orchestration, debugging connection, process sampling,
  profile lifecycle, reports, and chart generation.
- `verify_file.py`: standalone bounded-memory content/size verifier.
- `extension/manifest.json`: isolated Manifest V3 extension with downloads permission.
- `extension/test.html`: normal-tab test/status page, with an optional toolbar popup.
- `extension/test.js`: deterministic producer, initial state/pause checks, Finish
  observation, completion monitoring, and application counters.
- `requirements.txt`: Python dependencies; no JavaScript dependencies/build step.

The repository ignore rules exclude generated results, environments, and Python
bytecode. Selected results are documented in the repository's
`test_logs/python/README.md`.

The recorded submission run passed all three file-integrity checks. Its console
log, memory chart, and measurement CSV are in `test_logs/python/` at the
repository root. Always supply `--chromium` and the size/timeout options shown
above to reproduce this run.

No Chromium rebuild is required to load the test extension. The installed browser
must already implement the three APIs. Original test extensions remain unchanged.
This package does not test cancellation, ownership, unload/shutdown races, or prove
Finish completion ordering deterministically. The existing C++ suite covers several
cancellation, ownership, and unload cases; controlled completion ordering and
explicit shutdown checks remain additional work. Native UI appearance and history
persistence still require manual checks.
