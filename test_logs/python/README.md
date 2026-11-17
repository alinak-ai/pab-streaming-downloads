# Python streaming test evidence

The test code is in `../../memory_bound_test/`.

| Test | What it checks | Result |
| --- | --- | --- |
| 64 MiB + 1 GiB + 4 GiB | Three separate files, 20-second producer pauses, memory sampling, saved sizes and every byte | PASS |

## Recorded three-file test

Recorded UTC: 20261117T064957Z
Browser: `Chrome/138.0.7204.49`.
Timeout: 3,600 seconds. All transfers use 1 MiB chunks and await each Write.
Console log: `streaming_64MiB_1GiB_4GiB_pause20s_timeout3600s.log` (includes exact command, hashes for verified files, and exit code).
Runner result: **PASS**; exit code: **0**.
Temporary profile removed: **True**.

- 64 MiB: PASS; SHA-256 `21ceca4b56718a5dcaf8858a5b7d3a8cd9d0b33521ddc6aff62ead8006054963`.
- 1024 MiB: PASS; SHA-256 `cc00f1210e6e77d8d90aa4d4acc0640e5f1bac09e73f675bd1e1db789c07565e`.
- 4096 MiB: PASS; SHA-256 `1950dead6168a31738760319cee57dec7d043edc8d1c5b393a58b974ade4d502`.

The memory PNG shows sampled RSS by process role; the matching CSV contains the underlying measurements.
PSS is unavailable on Windows. These measurements do not prove a constant-memory bound.
The 20-second pauses stop the producer; this is not a paused-consumer backpressure test.
Finish closes the stream; the tests wait separately for native completion before verifying the files.

The browser reports an all-zero source revision, so its version alone does not identify an exact patch.
Full raw results and downloads remain outside this submission folder at `C:\ChromeSrc\memory_bound_test\results\streaming_64MiB_1GiB_4GiB_pause20s_timeout3600s_20261117T064957Z`.

## Test-source SHA-256 at the recorded run

The runner now requires an explicit `--chromium` argument instead of using a
machine-specific default. The recorded command already supplied this argument;
the hashes below identify the source used for that run.

- `run_streaming_tests.py`: `f22323761481e07ae312b6c9f716d33c6e102573918d2594dbdd3edfe6e8ad79`
- `verify_file.py`: `7c7b2a58a36e5b1ce0c9c863fe514fb16c06b9b4539b401779bb51f5e74d8f76`
- `extension/test.js`: `5660b229a19b2cc598256758e771ad7f7edf0998658deb358bc52e63b3495e41`
