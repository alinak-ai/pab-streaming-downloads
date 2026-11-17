#!/usr/bin/env python3
"""Verify the absolute-position test pattern using bounded memory."""
import argparse
import hashlib
import json
from pathlib import Path


def verify(path, expected_bytes):
    path = Path(path)
    actual_hash, expected_hash = hashlib.sha256(), hashlib.sha256()
    offset = 0
    mismatch = None
    with path.open('rb') as stream:
        while data := stream.read(65536):
            block = offset // 65536
            seed = 17 * block + 53 * (block // 256) + 97 * (block // 65536)
            pattern = bytes((31 * i + seed) & 255 for i in range(256))
            expected = (pattern * 256)[:len(data)]
            actual_hash.update(data)
            expected_hash.update(expected)
            if data != expected and mismatch is None:
                mismatch = offset + next(i for i, (a, b) in enumerate(zip(data, expected)) if a != b)
            offset += len(data)
    return {'status': 'PASS' if offset == expected_bytes and mismatch is None else 'FAIL',
            'path': str(path), 'expectedBytes': expected_bytes, 'actualBytes': offset,
            'firstMismatchOffset': mismatch, 'sha256': actual_hash.hexdigest(),
            'expectedPatternSha256ForActualLength': expected_hash.hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--expected-bytes', type=int, required=True)
    args = parser.parse_args()
    result = verify(args.file, args.expected_bytes)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['status'] == 'PASS' else 1)
