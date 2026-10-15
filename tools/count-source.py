"""Count NIU-owned physical source lines separately from vendored upstream.

Run from any directory: python tools/count-source.py
Counts include comments and blank lines; nonblank counts are also reported.
Dependencies, images, binaries and the unmodified upstream tree are excluded.
"""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
EXCLUDE = {'node', 'node_modules', 'runtime', 'bin', 'engine', 'dist', 'vendor', '.git'}
EXTENSIONS = {'.cs', '.mjs', '.js', '.ps1', '.sol', '.css', '.html', '.py'}


def row(path):
    data = path.read_bytes()
    lines = data.decode('utf-8-sig').splitlines()
    name = path.relative_to(ROOT).as_posix()
    return {'path': name, 'lines': len(lines), 'nonblank': sum(bool(s.strip()) for s in lines),
            'test': name.endswith('.test.mjs') or name.endswith('_test.go'),
            'sha256': hashlib.sha256(data).hexdigest()}


def collect(directory):
    for path in sorted(directory.iterdir()):
        if path.name in EXCLUDE:
            continue
        if path.is_dir():
            yield from collect(path)
        elif path.suffix in EXTENSIONS:
            yield row(path)


def total(rows):
    return {'files': len(rows), 'lines': sum(r['lines'] for r in rows),
            'nonblank': sum(r['nonblank'] for r in rows),
            'testLines': sum(r['lines'] for r in rows if r['test'])}


if __name__ == '__main__':
    files = list(collect(ROOT))
    baseline = json.loads((ROOT / 'docs/code-baseline.json').read_text(encoding='utf-8-sig'))
    added_node = [row(ROOT / 'node' / name) for name in baseline['newNodeFiles']]
    additions = sum(r['added'] for r in baseline['nodeDiff']) + sum(r['lines'] for r in added_node)
    deletions = sum(r['deleted'] for r in baseline['nodeDiff'])
    report = {
        'method': 'Physical UTF-8 source lines, including comments/blank lines; excludes upstream copy and dependencies.',
        'ownWalletAndTools': total(files),
        'nodeChangesFromUpstream': {'baseCommit': baseline['upstreamCommit'],
            'modifiedFiles': len(baseline['nodeDiff']), 'newFiles': len(added_node),
            'addedLines': additions, 'deletedLines': deletions, 'netLines': additions-deletions,
            'newTestLines': sum(r['lines'] for r in added_node if r['test'])},
        'walletEditsFromInitialStagingSnapshot': baseline['walletDiff'],
        'ownedFiles': files, 'newNodeFiles': added_node,
        'limitation': 'Line counts show implementation volume, not security, originality of every technique, human hours, or project completion.'}
    (ROOT / 'docs/code-metrics.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k: report[k] for k in ['ownWalletAndTools', 'nodeChangesFromUpstream']}, ensure_ascii=False, indent=2))
