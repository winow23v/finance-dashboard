"""Audit Pages artifacts without logging matched values or remote response bodies."""
import argparse
import base64
import json
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, urlsplit
from urllib.request import urlopen


SECRET_PATTERNS = {
    'Supabase secret key': rb'sb_secret_[A-Za-z0-9_-]{20,}',
    'OpenAI/Anthropic key': rb'sk-(?:proj-|ant-api[0-9]+-)?[A-Za-z0-9_-]{24,}',
    'GitHub token': rb'(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})',
    'AWS access key ID': rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
    'Stripe restricted/secret key': rb'\b[rs]k_live_[A-Za-z0-9]{16,}\b',
    'Slack token': rb'\bxox[baprs]-[A-Za-z0-9-]{16,}\b',
    'Private key': rb'-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----',
}
JWT = re.compile(rb'\beyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\b')
BUILD_PATTERNS = {
    'Source map reference': rb'(?m)(?://[#@]|/\*[#@])\s*sourceMappingURL\s*=',
    # Supabase Auth bundles a template-literal localhost:9999 SDK fallback.
    'Development network endpoint': rb'https?://(?!localhost:9999`)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(?:[/:]|["\x27])',
    'Internal filesystem path': rb'(?:/home/[\w.-]+/projects/|/opt/finance-us-market/|/var/lib/finance-us-market/)',
    'Test email address': rb'[\w.+-]+@(?:example\.(?:com|net|org)|example\.test)\b',
    'Work note': r'(?im)(?:<!--|/\*|^\s*//)\s*(?:TODO\b|FIXME\b|HACK\b|작업 메모)',
}


class Policies(HTMLParser):
    def __init__(self, body):
        super().__init__()
        self.csp = self.referrer = None
        self.asset_seen = False
        self.feed(body.decode('utf-8'))

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('script', 'link', 'style'):
            self.asset_seen = True
        if tag != 'meta':
            return
        if not self.asset_seen and attrs.get('http-equiv', '').lower() == 'content-security-policy':
            self.csp = attrs.get('content')
        if attrs.get('name', '').lower() == 'referrer':
            self.referrer = attrs.get('content')


def inspect(path, body, patterns):
    findings = [(label, match.start()) for label, pattern in patterns.items()
                for match in re.finditer(pattern if isinstance(pattern, bytes) else pattern.encode(), body)]
    for match in JWT.finditer(body):
        payload = match[1]
        try:
            claims = json.loads(base64.urlsafe_b64decode(payload + b'=' * (-len(payload) % 4)))
        except (ValueError, UnicodeError):
            continue
        if isinstance(claims, dict) and claims.get('role') == 'service_role':
            findings.append(('Supabase service_role JWT', match.start()))
    for label in sorted({label for label, _ in findings}):
        offset = next(offset for name, offset in findings if name == label)
        print(f'{path}:{body.count(bytes((10,)), 0, offset) + 1}: {label}')
    return len(findings)


def build_files(root):
    files = [p.relative_to(root) for p in sorted(root.rglob('*')) if p.is_file()]
    if Path('index.html') not in files:
        raise ValueError('Build index.html is missing')
    return files


def audit_build(root, files):
    findings = 0
    for path in files:
        if path.suffix.lower() == '.map' or any(part.startswith('.') for part in path.parts):
            print(f'{path}: unexpected deployable file')
            findings += 1
        body = (root / path).read_bytes()
        findings += inspect(path, body, SECRET_PATTERNS | BUILD_PATTERNS)
    policy = Policies((root / 'index.html').read_bytes())
    if not policy.csp or "'unsafe-eval'" in policy.csp or "object-src 'none'" not in policy.csp:
        print('index.html: missing or invalid CSP before asset tags')
        findings += 1
    if policy.referrer != 'strict-origin-when-cross-origin':
        print('index.html: expected referrer policy is missing')
        findings += 1
    print(f'Build: {len(files)} files, {findings} findings')
    return findings


def audit_deployment(root, files, url):
    base = urlsplit(url)
    if base.scheme != 'https' or not base.hostname or not url.endswith('/'):
        raise ValueError('Expected an HTTPS Pages URL ending in /')
    with urlopen('http://' + url.removeprefix('https://'), timeout=20) as response:
        if response.url != url:
            raise ValueError('HTTP did not redirect to the expected HTTPS page')
    findings = 0
    for path in files:
        uri = url if path == Path('index.html') else url + quote(path.as_posix())
        with urlopen(uri, timeout=20) as response:
            if response.url != uri:
                raise ValueError('Unexpected deployed artifact redirect')
            if path == Path('index.html'):
                headers = response.headers
                if not re.search(r'\bmax-age\s*=\s*[1-9]\d*', headers.get('Strict-Transport-Security', ''), re.I):
                    print('index.html: missing positive HSTS max-age')
                    findings += 1
                for name in ('Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options', 'X-Frame-Options'):
                    state = 'present' if headers.get(name) else 'absent'
                    print(f'{name} response header: {state}')
            mime = response.headers.get_content_type()
            expected_mime = {'.html': {'text/html'}, '.css': {'text/css'},
                             '.js': {'text/javascript', 'application/javascript'}}
            if path.suffix in expected_mime and mime not in expected_mime[path.suffix]:
                print(f'{path}: unexpected response MIME type')
                findings += 1
            expected = (root / path).read_bytes()
            if response.read(len(expected) + 1) != expected:
                print(f'{path}: deployed content differs from the audited build')
                findings += 1
    print(f'Deployment: {len(files)} files compared, {findings} regressions')
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    targets = parser.add_mutually_exclusive_group(required=True)
    targets.add_argument('--dist', type=Path)
    targets.add_argument('--tracked', action='store_true')
    parser.add_argument('--url', help='Compare deployment against --dist')
    args = parser.parse_args()
    if args.url and args.tracked:
        parser.error('--url requires --dist')
    try:
        if args.tracked:
            output = subprocess.check_output(['git', 'ls-files', '-z'])
            paths = [Path(item.decode()) for item in output.split(b'\0') if item]
            findings = sum(inspect(path, path.read_bytes(), SECRET_PATTERNS)
                           for path in paths if path.is_file() and not path.is_symlink())
            print(f'Tracked snapshot: {len(paths)} paths, {findings} findings')
        else:
            files = build_files(args.dist)
            findings = audit_build(args.dist, files)
            if args.url and not findings:
                findings += audit_deployment(args.dist, files, args.url)
        return int(bool(findings))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Audit execution error ({type(error).__name__})', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
