#!/usr/bin/env python3
"""Launch isolated Chromium streaming tests, measure memory, verify output."""
import argparse
import csv
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

try:
    import psutil
    import websocket
except ImportError as error:
    raise SystemExit(f'Missing dependency: {error}. See README.md (psutil, websocket-client).')

from verify_file import verify


class CDP:
    def __init__(self, url):
        self.socket = websocket.create_connection(url, timeout=20, suppress_origin=True)
        self.sequence = 0

    def call(self, method, params=None, session=None):
        self.sequence += 1
        message = {'id': self.sequence, 'method': method, 'params': params or {}}
        if session:
            message['sessionId'] = session
        self.socket.send(json.dumps(message))
        while True:
            response = json.loads(self.socket.recv())
            if response.get('id') == self.sequence:
                if 'error' in response:
                    raise RuntimeError(f'{method}: {response["error"]}')
                return response.get('result', {})

    def evaluate(self, session, expression):
        response = self.call('Runtime.evaluate', {
            'expression': expression, 'returnByValue': True, 'timeout': 5000
        }, session)
        if 'exceptionDetails' in response:
            raise RuntimeError(str(response['exceptionDetails']))
        return response.get('result', {}).get('value')


def role(args, pid, browser_pid):
    if pid == browser_pid:
        return 'browser'
    kind = next((s.split('=', 1)[1] for s in args if s.startswith('--type=')), '')
    if kind == 'renderer':
        return 'extension_renderer' if '--extension-process' in args else 'other_renderer'
    return kind or 'other'


def sample_memory(browser_pid, status, writer, elapsed, rows):
    try:
        root = psutil.Process(browser_pid)
        processes = [root, *root.children(recursive=True)]
    except psutil.Error:
        return
    for process in processes:
        try:
            args = process.cmdline()
            info = process.memory_info()
            pss = uss = None
            try:
                full = process.memory_full_info()
                pss, uss = getattr(full, 'pss', None), getattr(full, 'uss', None)
            except (psutil.Error, OSError):
                pass
            row = {'elapsedSeconds': round(elapsed, 3), 'caseIndex': status.get('caseIndex', -1),
                   'phase': status.get('phase', 'startup'), 'sentBytes': status.get('sentBytes', 0),
                   'pid': process.pid, 'role': role(args, process.pid, browser_pid),
                   'rssBytes': info.rss, 'pssBytes': pss, 'ussBytes': uss}
            writer.writerow(row)
            rows.append(row)
        except (psutil.Error, OSError):
            continue


def summarize_memory(rows):
    grouped = {}
    for row in rows:
        key = (row['caseIndex'], row['role'], row['elapsedSeconds'])
        item = grouped.setdefault(key, {'rss': 0, 'pss': 0, 'hasPss': True})
        item['rss'] += row['rssBytes']
        item['hasPss'] &= row['pssBytes'] is not None
        item['pss'] += row['pssBytes'] or 0
    summary = {}
    for (case, group, stamp), values in sorted(grouped.items()):
        key = f'case-{case}/{group}'
        item = summary.setdefault(key, {'firstSampleRssBytes': values['rss'],
                                        'peakRssBytes': 0, 'peakPssBytes': None, 'samples': 0})
        item['lastSampleRssBytes'] = values['rss']
        item['peakRssBytes'] = max(item['peakRssBytes'], values['rss'])
        if values['hasPss']:
            item['peakPssBytes'] = max(item['peakPssBytes'] or 0, values['pss'])
        item['samples'] += 1
    return summary, grouped


def make_chart(grouped, path):
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        return 'Chart omitted: matplotlib is not installed; raw CSV remains available.'
    fig, axes = plt.subplots(2, 1, figsize=(10, 7), sharex=True)
    for group in sorted({key[1] for key in grouped}):
        samples = sorted((stamp, values) for (_, category, stamp), values in grouped.items() if category == group)
        axes[0].plot([s for s, _ in samples], [v['rss'] / 1024**2 for _, v in samples], label=group)
        pss = [(s, v['pss']) for s, v in samples if v['hasPss']]
        if pss:
            axes[1].plot([s for s, _ in pss], [v / 1024**2 for _, v in pss], label=group)
    axes[0].set_ylabel('RSS (MiB)')
    axes[1].set_ylabel('PSS (MiB)')
    axes[1].set_xlabel('Seconds since launch')
    for axis in axes:
        axis.grid(alpha=.3)
        handles, labels = axis.get_legend_handles_labels()
        if handles:
            axis.legend(handles, labels, fontsize=8)
        else:
            axis.text(.5, .5, 'No measurements available',
                      ha='center', va='center', transform=axis.transAxes)
    fig.suptitle('Isolated test browser: memory by process role\nRSS includes shared pages; PSS apportions them')
    fig.tight_layout()
    fig.savefig(path, dpi=140)
    plt.close(fig)
    return str(path.name)


def run(args):
    here = Path(__file__).resolve().parent
    extension = (here / 'extension').resolve()
    browser = args.chromium.resolve()
    if not browser.is_file():
        raise RuntimeError(f'Chromium executable not found: {browser}')
    # Match crx_file::id_util::GenerateIdForPath: native path bytes, with an
    # uppercase drive letter on Windows (where FilePath uses UTF-16).
    extension_path = str(extension)
    if os.name == 'nt':
        if len(extension_path) >= 2 and extension_path[1] == ':':
            extension_path = extension_path[0].upper() + extension_path[1:]
        extension_bytes = extension_path.encode('utf-16-le')
    else:
        extension_bytes = os.fsencode(extension_path)
    extension_id = hashlib.sha256(extension_bytes).hexdigest()[:32].translate(
        str.maketrans('0123456789abcdef', 'abcdefghijklmnop'))
    output = args.output.resolve() if args.output else here / 'results' / dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    output.mkdir(parents=True, exist_ok=False)
    downloads = output / 'downloads'
    downloads.mkdir()
    profile = output / 'profile'
    required = sum(args.sizes_mib) * 1024**2 + 512 * 1024**2
    if shutil.disk_usage(output).free < required:
        raise RuntimeError(f'Insufficient space: need {required / 1024**3:.2f} GiB including headroom')
    config = {'runId': output.name, 'sizesMiB': args.sizes_mib, 'chunkBytes': args.chunk_kib * 1024,
              'delayMs': args.delay_ms, 'pauseSeconds': args.pause_seconds, 'completionTimeoutSeconds': 120}
    command = [str(browser), '--headless=new', '--no-first-run', '--no-default-browser-check',
               '--disable-background-networking', '--disable-component-update', '--disable-sync',
               '--remote-debugging-port=0', '--password-store=basic', '--enable-automation',
               f'--user-data-dir={profile}', f'--disable-extensions-except={extension}',
               f'--load-extension={extension}', 'about:blank']
    report = {'configuration': config, 'browserCommand': command, 'extensionId': extension_id,
              'limitations': [
                  'Headless API checks do not visually verify the native download UI or history.',
                  'An immediate completed-state observation does not prove Finish waits for completion.',
                  'Sampled process memory is evidence for these runs, not proof of a constant bound.',
                  'RSS summed across processes can double-count shared memory; PSS is preferred.',
                  'Python verification runs after transfers and is outside the measured browser process tree.'
              ]}
    try:
        report['sourceCheckoutHead'] = subprocess.check_output(
            ['git', '-C', str(browser.parent.parent.parent), 'rev-parse', 'HEAD'],
            stderr=subprocess.DEVNULL, text=True, timeout=10).strip()
    except (OSError, subprocess.SubprocessError):
        report['sourceCheckoutHead'] = None
    report['revisionNote'] = 'Checkout HEAD is separate from the binary revision reported by Browser.getVersion.'
    cdp = process = None
    rows, progress_rows = [], []
    status = {'phase': 'startup'}
    started = time.monotonic()
    print(f'Results: {output}', flush=True)
    try:
        with (output / 'browser.log').open('w') as log, (output / 'memory.csv').open('w', newline='') as memory:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            fields = ['elapsedSeconds', 'caseIndex', 'phase', 'sentBytes', 'pid', 'role', 'rssBytes', 'pssBytes', 'ussBytes']
            writer = csv.DictWriter(memory, fieldnames=fields)
            writer.writeheader()
            deadline = time.monotonic() + 45
            port_file = profile / 'DevToolsActivePort'
            while not port_file.exists():
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Browser startup failed; see browser.log')
                time.sleep(.1)
            port, endpoint = port_file.read_text().splitlines()[:2]
            cdp = CDP(f'ws://127.0.0.1:{port}{endpoint}')
            report['browserVersion'] = cdp.call('Browser.getVersion')
            print('Browser:', report['browserVersion']['product'], report['browserVersion'].get('revision'), flush=True)
            cdp.call('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': str(downloads), 'eventsEnabled': True})
            target = cdp.call('Target.createTarget', {'url': f'chrome-extension://{extension_id}/test.html'})['targetId']
            session = cdp.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
            deadline = time.monotonic() + 20
            while not cdp.evaluate(session, 'typeof window.startRun === "function"'):
                if time.monotonic() > deadline:
                    raise RuntimeError('Extension page did not load; see browser.log')
                time.sleep(.1)
            cdp.evaluate(session, f'window.startRun({json.dumps(config)})')
            previous = None
            next_sample = 0
            while True:
                if time.monotonic() - started > args.timeout_seconds:
                    raise RuntimeError('Run timed out')
                status = cdp.evaluate(session, 'window.runnerStatus')
                elapsed = time.monotonic() - started
                current = (status.get('caseIndex'), status.get('phase'))
                if current != previous:
                    print(f'{elapsed:6.1f}s case={current[0]} phase={current[1]} sent={status.get("sentBytes", 0)}', flush=True)
                    previous = current
                if elapsed >= next_sample:
                    sample_memory(process.pid, status, writer, elapsed, rows)
                    memory.flush()
                    partials = list(downloads.glob('*.crdownload'))
                    partial_bytes = 0
                    for partial in partials:
                        try:
                            partial_bytes += partial.stat().st_size
                        except FileNotFoundError:
                            pass
                    progress_rows.append({'elapsedSeconds': round(elapsed, 3), 'caseIndex': status.get('caseIndex'),
                                          'phase': status.get('phase'), 'sentBytes': status.get('sentBytes'),
                                          'partialFileBytes': partial_bytes, 'download': status.get('progress')})
                    next_sample = elapsed + args.sample_seconds
                report['extensionResults'] = status
                (output / 'live-status.json').write_text(json.dumps(status, indent=2) + '\n')
                if status.get('done'):
                    if status.get('error'):
                        raise RuntimeError(status['error'])
                    break
                time.sleep(.25)
            report['fileVerification'] = []
            for case in status['cases']:
                samples = [s for s in progress_rows if s['caseIndex'] == case['caseIndex']]
                active_samples = [s for s in samples if s['phase'] in ('generating', 'producer-pause')]
                sizes = [s['partialFileBytes'] for s in samples]
                case['partialFileGrowthObservation'] = {
                    'samples': len(samples),
                    'partialFileSeenDuringProduction': any(s['partialFileBytes'] > 0 for s in active_samples),
                    'growthBetweenSamplesSeen': bool(sizes and max(sizes) > min(sizes)),
                    'note': 'Short runs can finish between samples; absence of a sample is not a failure.'}
                path = Path(case['final']['filename']).resolve()
                if not path.is_relative_to(downloads.resolve()):
                    raise RuntimeError(f'Unexpected download destination: {path}')
                print('Verifying:', path.name, flush=True)
                result = verify(path, case['requestedBytes'])
                report['fileVerification'].append(result)
                print(result['status'], result['sha256'], flush=True)
            report['status'] = 'PASS' if all(v['status'] == 'PASS' for v in report['fileVerification']) else 'FAIL'
    except (Exception, KeyboardInterrupt) as error:
        report['status'] = 'FAIL'
        report['error'] = str(error) or 'Interrupted by user'
        print('Run failed:', report['error'], file=sys.stderr, flush=True)
    finally:
        if cdp:
            try:
                cdp.call('Browser.close')
            except Exception:
                pass
            cdp.socket.close()
        if process:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                if os.name == 'nt':
                    # Limit cleanup to this runner's browser and descendants.
                    try:
                        root = psutil.Process(process.pid)
                        owned = [*root.children(recursive=True), root]
                    except psutil.NoSuchProcess:
                        owned = []
                    for child in owned:
                        try:
                            child.terminate()
                        except psutil.NoSuchProcess:
                            pass
                    _, alive = psutil.wait_procs(owned, timeout=5)
                    for child in alive:
                        try:
                            child.kill()
                        except psutil.NoSuchProcess:
                            pass
                    psutil.wait_procs(alive, timeout=5)
                    process.wait(timeout=5)
                else:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
        if profile.exists() and not args.keep_profile:
            try:
                shutil.rmtree(profile)
            except OSError as error:
                report['profileCleanupError'] = str(error)
        report['memorySummary'], grouped = summarize_memory(rows)
        report['memoryChart'] = make_chart(grouped, output / 'memory.png') if grouped else None
        (output / 'progress.json').write_text(json.dumps(progress_rows, indent=2) + '\n')
        (output / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
        text = [f'Run status: {report["status"]} (transfer and file checks only)', '',
                'Case | MiB | Finish observation | File verification', '--- | --- | --- | ---']
        verifications = report.get('fileVerification', [])
        for index, case in enumerate(status.get('cases', [])):
            checked = verifications[index]['status'] if index < len(verifications) else 'UNTESTED'
            text.append(f'{index} | {case["requestedBytes"] / 1024**2:g} | {case.get("finishObservation", "UNTESTED")} | {checked}')
        text += ['', 'Memory: measured; no automatic constant-memory verdict.', '',
                 'Case / role | First RSS MiB | Peak RSS MiB | Last RSS MiB | Peak PSS MiB',
                 '--- | --- | --- | --- | ---']
        for key, values in report['memorySummary'].items():
            if key.endswith('/browser') or key.endswith('/extension_renderer'):
                pss = values['peakPssBytes']
                pss_text = f'{pss / 1024**2:.1f}' if pss is not None else 'unavailable'
                text.append(f'{key} | {values["firstSampleRssBytes"] / 1024**2:.1f} | '
                            f'{values["peakRssBytes"] / 1024**2:.1f} | '
                            f'{values["lastSampleRssBytes"] / 1024**2:.1f} | {pss_text}')
        text += ['', 'Application counters (pending writes and submitted chunk size) are not process-memory measurements.',
                 '', *report['limitations']]
        if report.get('error'):
            text += ['', 'Error: ' + report['error']]
        (output / 'REPORT.md').write_text('\n'.join(text) + '\n')
        print(f'{report["status"]}: {output / "REPORT.md"}', flush=True)
    return 0 if report['status'] == 'PASS' else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium', type=Path, required=True,
                        help='Path to the patched Chromium executable.')
    parser.add_argument('--sizes-mib', type=int, nargs='+', default=[64, 1024])
    parser.add_argument('--chunk-kib', type=int, default=1024)
    parser.add_argument('--pause-seconds', type=float, default=20)
    parser.add_argument('--delay-ms', type=float, default=5)
    parser.add_argument('--sample-seconds', type=float, default=1)
    parser.add_argument('--timeout-seconds', type=float, default=1800)
    parser.add_argument('--output', type=Path, help='New results directory (must not already exist)')
    parser.add_argument('--keep-profile', action='store_true')
    args = parser.parse_args()
    if any(n <= 0 for n in args.sizes_mib) or not 1 <= args.chunk_kib <= 65536:
        parser.error('Sizes must be positive; chunk-kib must be between 1 and 65536')
    if args.pause_seconds < 0 or args.delay_ms < 0 or args.sample_seconds <= 0 or args.timeout_seconds <= 0:
        parser.error('Timing arguments are out of range')
    try:
        return run(args)
    except (OSError, RuntimeError) as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
