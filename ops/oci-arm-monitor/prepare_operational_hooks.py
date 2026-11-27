"""Stage instrumented copies of the two verified operational scripts."""
import argparse
import hashlib
from pathlib import Path

MONITOR_SHA256 = "0fb825a532f490ccc14c69d940a94335852d463eb7b6b46ed05fbe19ced1350b"
ORCHESTRATOR_SHA256 = "2d3186e8cb454b0a1785498daf9f567ab5581a3f09504fb4e605798c8670e75a"


def read_verified(root, name, expected_sha):
    source = (root / name).read_bytes()
    if hashlib.sha256(source).hexdigest() != expected_sha:
        raise ValueError(f"{name} differs from the verified operational export")
    return source.decode("utf-8").splitlines(keepends=True)


def prepare_monitor(lines):
    # Coordinates refer to the verified export. Record successful OCI calls
    # before unrelated state parsing, notification enqueue and disk writes.
    return "".join(lines[:23]) + "\noci_query_completed = False\n" + "".join(lines[23:92]) + """
    oci_query_completed = True
    try:
        from status_snapshot import record_operational_oci_result
        ad_number = AD.rsplit("-", 1)[-1]
        record_operational_oci_result(
            {**current, "availability_domain": f"AD-{ad_number}"}, failed=False, root=ROOT,
        )
    except Exception:
        log("STATUS: Could not record successful OCI query")
""" + "".join(lines[92:147]) + """    if not oci_query_completed:
        try:
            from status_snapshot import record_operational_oci_result
            record_operational_oci_result(failed=True, root=ROOT)
        except Exception:
            log("STATUS: Could not record failed OCI query")
""" + "".join(lines[147:])


def prepare_orchestrator(lines):
    # The inserted finally runs inside the existing lock after all acquired paths.
    body = "".join("    " + line if line.strip() else line for line in lines[38:124])
    return "".join(lines[:38]) + "        try:\n" + body + """        finally:
            try:
                from status_snapshot import read_notification_status, write_operational_snapshot
                write_operational_snapshot(
                    ROOT, notification=read_notification_status(ROOT), interval_seconds=3600,
                )
            except Exception:
                log("STATUS: Could not publish OCI monitor snapshot")
""" + "".join(lines[124:])


def prepare(source, destination):
    if destination.resolve() == source.resolve():
        raise ValueError("Choose a separate staging directory")
    staged = {
        "monitor.py": prepare_monitor(read_verified(source, "monitor.py", MONITOR_SHA256)),
        "orchestrator.py": prepare_orchestrator(read_verified(source, "orchestrator.py", ORCHESTRATOR_SHA256)),
    }
    for name, content in staged.items():
        compile(content, name, "exec")
    destination.mkdir(mode=0o700)
    for name, content in staged.items():
        (destination / name).write_text(content, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path, help="new private staging directory")
    args = parser.parse_args()
    try:
        prepare(args.source, args.destination)
    except (OSError, ValueError, SyntaxError) as error:
        parser.exit(1, f"Integration staging failed: {type(error).__name__}: {error}\n")


if __name__ == "__main__":
    main()
