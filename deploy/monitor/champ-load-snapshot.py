#!/usr/bin/env python3
"""champ-load-snapshot.py: one-shot capacity snapshot of the Deepify VPS.

Prints a single JSON document describing how loaded the box and every
container on it are right now, plus request rates from the host nginx logs.
Feeds the ChampBeam capacity report; champ-health.sh stays the alerting path.

Run on the VPS (python3 only, no extra packages):

    python3 champ-load-snapshot.py > /var/www/fleet/load-snapshot.json

Or from a laptop, without copying anything first:

    ssh root@64.227.154.215 python3 - < deploy/monitor/champ-load-snapshot.py > load-snapshot.json

Every section is best-effort: a missing tool or log produces a null section,
never a crash, so the snapshot is always usable.
"""

from __future__ import annotations

import datetime as dt
import glob
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter, defaultdict


def sh(cmd: str, timeout: int = 60) -> str:
    try:
        return subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        ).stdout
    except Exception:  # noqa: BLE001
        return ""


def guard(fn):
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)[:200]}


# ----------------------------------------------------------------- host
def host() -> dict:
    load1, load5, load15 = (float(x) for x in open("/proc/loadavg").read().split()[:3])
    cpus = os.cpu_count() or 1
    mem = {}
    for line in open("/proc/meminfo"):
        k, v = line.split(":", 1)
        mem[k] = int(v.strip().split()[0]) * 1024
    total, avail = mem["MemTotal"], mem.get("MemAvailable", 0)
    swap_total, swap_free = mem.get("SwapTotal", 0), mem.get("SwapFree", 0)
    disks = []
    for mnt in ("/", "/var/lib/docker", "/data"):
        if os.path.ismount(mnt) or mnt == "/":
            u = shutil.disk_usage(mnt)
            disks.append(
                {"mount": mnt, "total": u.total, "used": u.used, "free": u.free,
                 "pct": round(u.used / u.total * 100, 1)}
            )
    up = float(open("/proc/uptime").read().split()[0])
    model = sh("lscpu | grep 'Model name' | cut -d: -f2").strip()
    # /proc/stat two-sample CPU busy percent over one second.
    def cpu_sample():
        f = open("/proc/stat").readline().split()[1:]
        v = list(map(int, f))
        return sum(v), v[3] + v[4]
    import time
    t1, i1 = cpu_sample(); time.sleep(1); t2, i2 = cpu_sample()
    busy = round((1 - (i2 - i1) / max(1, t2 - t1)) * 100, 1)
    return {
        "hostname": os.uname().nodename,
        "kernel": os.uname().release,
        "cpu_model": model,
        "cpus": cpus,
        "cpu_busy_pct_1s": busy,
        "load": {"1m": load1, "5m": load5, "15m": load15,
                 "per_cpu_1m": round(load1 / cpus, 2)},
        "mem": {"total": total, "available": avail, "used_pct": round((1 - avail / total) * 100, 1)},
        "swap": {"total": swap_total, "used": swap_total - swap_free,
                 "used_pct": round((swap_total - swap_free) / swap_total * 100, 1) if swap_total else 0},
        "disks": disks,
        "uptime_days": round(up / 86400, 1),
        "docker_disk": sh("docker system df --format '{{json .}}'").strip().splitlines(),
    }


# ----------------------------------------------------------------- docker
def _bytes(s: str) -> float:
    s = s.strip()
    m = re.match(r"([\d.]+)\s*([kKMGT]?i?B)", s)
    if not m:
        return 0.0
    n, unit = float(m.group(1)), m.group(2)
    mult = {"B": 1, "kB": 1e3, "KB": 1e3, "KiB": 1024, "MB": 1e6, "MiB": 1024**2,
            "GB": 1e9, "GiB": 1024**3, "TB": 1e12, "TiB": 1024**4}
    return n * mult.get(unit, 1)


def containers() -> list:
    stats = {}
    for line in sh("docker stats --no-stream --format '{{json .}}'", 90).splitlines():
        try:
            j = json.loads(line)
        except json.JSONDecodeError:
            continue
        mem_use, mem_lim = (j.get("MemUsage", "0B / 0B").split("/") + ["0B"])[:2]
        net_rx, net_tx = (j.get("NetIO", "0B / 0B").split("/") + ["0B"])[:2]
        blk_r, blk_w = (j.get("BlockIO", "0B / 0B").split("/") + ["0B"])[:2]
        stats[j["Name"]] = {
            "cpu_pct": float(j.get("CPUPerc", "0%").rstrip("%") or 0),
            "mem_bytes": _bytes(mem_use), "mem_limit": _bytes(mem_lim),
            "mem_pct": float(j.get("MemPerc", "0%").rstrip("%") or 0),
            "net_rx": _bytes(net_rx), "net_tx": _bytes(net_tx),
            "blk_read": _bytes(blk_r), "blk_write": _bytes(blk_w),
            "pids": int(j.get("PIDs", 0) or 0),
        }
    out = []
    ids = sh("docker ps -a -q").split()
    if not ids:
        return out
    fmt = ("{{json .}}")
    raw = sh("docker inspect " + " ".join(ids), 90)
    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        items = []
    for c in items:
        name = c["Name"].lstrip("/")
        labels = c["Config"].get("Labels") or {}
        app = (labels.get("coolify.applicationName") or labels.get("coolify.serviceName")
               or labels.get("com.docker.compose.project") or name)
        st = c["State"]
        hc = (st.get("Health") or {}).get("Status")
        out.append({
            "name": name,
            "app": app,
            "image": c["Config"].get("Image"),
            "status": st.get("Status"),
            "health": hc,
            "restarts": c.get("RestartCount", 0),
            "started_at": st.get("StartedAt"),
            "mem_limit_cfg": c["HostConfig"].get("Memory", 0),
            "cpu_quota_cfg": c["HostConfig"].get("NanoCpus", 0),
            "restart_policy": (c["HostConfig"].get("RestartPolicy") or {}).get("Name"),
            **stats.get(name, {}),
        })
    out.sort(key=lambda x: -(x.get("mem_bytes") or 0))
    return out


# ----------------------------------------------------------------- postgres
def postgres() -> list:
    out = []
    names = sh("docker ps --format '{{.Names}} {{.Image}}'").splitlines()
    for line in names:
        name, image = (line.split() + [""])[:2]
        if "postgres" not in image:
            continue
        q = ("select datname, pg_database_size(datname) from pg_database "
             "where not datistemplate;")
        sizes = sh(f"docker exec {name} psql -U postgres -Atc \"{q}\" 2>/dev/null "
                   f"|| docker exec {name} sh -c 'psql -U \"$POSTGRES_USER\" -Atc \"{q}\"'")
        conns = sh(f"docker exec {name} sh -c 'psql -U \"${{POSTGRES_USER:-postgres}}\" -Atc "
                   f"\"select count(*), (select setting from pg_settings where name=\\'max_connections\\') from pg_stat_activity\"'")
        dbs = []
        for row in sizes.strip().splitlines():
            if "|" in row:
                d, s = row.split("|")
                dbs.append({"db": d, "bytes": int(s)})
        tables = sh(
            f"docker exec {name} sh -c 'psql -U \"${{POSTGRES_USER:-postgres}}\" -Atc "
            "\"select relname, n_live_tup, pg_total_relation_size(relid) from pg_stat_user_tables "
            "order by pg_total_relation_size(relid) desc limit 12\"'")
        top = []
        for row in tables.strip().splitlines():
            p = row.split("|")
            if len(p) == 3:
                top.append({"table": p[0], "rows": int(p[1]), "bytes": int(p[2])})
        c = conns.strip().split("|") if "|" in conns else ["", ""]
        out.append({"container": name, "image": image, "databases": dbs,
                    "connections": c[0], "max_connections": c[1], "top_tables": top})
    return out


# ----------------------------------------------------------------- redis
def redis() -> list:
    out = []
    for line in sh("docker ps --format '{{.Names}} {{.Image}}'").splitlines():
        name, image = (line.split() + [""])[:2]
        if "redis" not in image:
            continue
        info = sh(f"docker exec {name} redis-cli info memory 2>/dev/null")
        keys = sh(f"docker exec {name} redis-cli dbsize 2>/dev/null").strip()
        used = re.search(r"used_memory:(\d+)", info)
        peak = re.search(r"used_memory_peak:(\d+)", info)
        out.append({"container": name, "used": int(used.group(1)) if used else None,
                    "peak": int(peak.group(1)) if peak else None, "keys": keys})
    return out


# ----------------------------------------------------------------- nginx logs
LOG_RE = re.compile(
    r'^(?P<ip>\S+) \S+ \S+ \[(?P<ts>[^\]]+)\] "(?P<method>\S+) (?P<path>\S+) [^"]*" '
    r'(?P<status>\d{3}) (?P<bytes>\d+|-)(?: "(?P<ref>[^"]*)" "(?P<ua>[^"]*)")?'
    r'(?: "(?P<host>[^"]*)")?(?: (?P<rt>[\d.]+))?')


def nginx() -> dict:
    files = sorted(glob.glob("/var/log/nginx/*access*.log*"))
    if not files:
        return {"available": False}
    now = dt.datetime.now(dt.timezone.utc)
    h24 = now - dt.timedelta(hours=24)
    h1 = now - dt.timedelta(hours=1)
    d7 = now - dt.timedelta(days=7)
    per_host_24 = Counter(); per_host_1 = Counter(); per_host_7 = Counter()
    status_24 = defaultdict(Counter); hourly = Counter()
    path_24 = defaultdict(Counter); slow = defaultdict(list)
    ua_bots = Counter(); total = 0; parsed = 0
    for f in files:
        opener = gzip.open if f.endswith(".gz") else open
        try:
            with opener(f, "rt", errors="replace") as fh:
                for line in fh:
                    total += 1
                    m = LOG_RE.match(line)
                    if not m:
                        continue
                    try:
                        ts = dt.datetime.strptime(m.group("ts"), "%d/%b/%Y:%H:%M:%S %z")
                    except ValueError:
                        continue
                    if ts < d7:
                        continue
                    parsed += 1
                    host = (m.group("host") or "").lower()
                    # Fall back to vhost from the log file name when the format lacks $host.
                    if not host or host == "-":
                        host = os.path.basename(f).replace(".access.log", "").split(".log")[0]
                    per_host_7[host] += 1
                    if ts >= h24:
                        per_host_24[host] += 1
                        status_24[host][m.group("status")[0] + "xx"] += 1
                        hourly[ts.strftime("%Y-%m-%dT%H:00Z")] += 1
                        p = m.group("path").split("?")[0]
                        p = re.sub(r"/(r|s|f|p)/[^/]+", r"/\1/{code}", p)
                        path_24[host][p] += 1
                        ua = (m.group("ua") or "").lower()
                        if any(b in ua for b in ("bot", "crawler", "spider", "curl", "python", "monitor")):
                            ua_bots[host] += 1
                        if m.group("rt"):
                            slow[host].append(float(m.group("rt")))
                    if ts >= h1:
                        per_host_1[host] += 1
        except Exception:  # noqa: BLE001
            continue
    def pct(v, q):
        if not v:
            return None
        v = sorted(v); return round(v[min(len(v) - 1, int(len(v) * q))], 3)
    return {
        "available": True,
        "files": len(files), "lines_seen": total, "lines_parsed_7d": parsed,
        "requests_1h": dict(per_host_1),
        "requests_24h": dict(per_host_24),
        "requests_7d": dict(per_host_7),
        "status_24h": {h: dict(c) for h, c in status_24.items()},
        "bot_share_24h": {h: round(ua_bots[h] / max(1, per_host_24[h]), 3) for h in per_host_24},
        "hourly_24h": dict(sorted(hourly.items())),
        "top_paths_24h": {h: c.most_common(8) for h, c in path_24.items()},
        "latency_24h": {h: {"p50": pct(v, .5), "p95": pct(v, .95), "p99": pct(v, .99), "n": len(v)}
                        for h, v in slow.items()},
    }


def fleet_status() -> dict | None:
    p = "/var/www/fleet/fleet-status.json"
    if os.path.exists(p):
        with open(p) as fh:
            return json.load(fh)
    return None


def coolify_apps() -> list:
    # Which Coolify applications exist and their FQDNs, from container labels.
    seen = {}
    for line in sh("docker ps --format '{{.Names}}|{{.Label \"coolify.applicationName\"}}|{{.Label \"coolify.fqdn\"}}|{{.Label \"coolify.projectName\"}}'").splitlines():
        n, app, fqdn, proj = (line.split("|") + ["", "", ""])[:4]
        if app:
            seen.setdefault(app, {"project": proj, "fqdn": fqdn, "containers": []})["containers"].append(n)
    return [{"app": k, **v} for k, v in seen.items()]


def main() -> None:
    doc = {
        "schema": "champ-load-snapshot/1",
        "taken_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "host": guard(host),
        "containers": guard(containers),
        "coolify_apps": guard(coolify_apps),
        "postgres": guard(postgres),
        "redis": guard(redis),
        "nginx": guard(nginx),
        "fleet_status": guard(fleet_status),
    }
    json.dump(doc, sys.stdout, indent=1, default=str)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
