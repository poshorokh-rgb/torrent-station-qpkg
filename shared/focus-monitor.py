#!/usr/bin/env python3
"""Restore files paused by Torrent Station's Focus-download mode.

The marker lives in a Transmission label, so this worker survives browser
closures and NAS restarts. It removes the marker only after it has verified
that the remaining files were resumed once the focused file reaches 100%.
"""
import base64
import json
import re
import sys
import time
from urllib2 import HTTPError, Request, urlopen

MARKER = re.compile(r"^__torrentstation_focus_(\d+)$")


def credentials(path):
    values = {}
    for line in open(path, "r").read().splitlines():
        if ": " in line:
            key, value = line.split(": ", 1)
            values[key] = value
    return values["Username"], values["Password"]


def rpc(port, user, password, method, arguments):
    auth = base64.b64encode("%s:%s" % (user, password))
    payload = json.dumps({"method": method, "arguments": arguments}).encode()
    headers = {"Authorization": "Basic %s" % auth, "Content-Type": "application/json"}
    url = "http://127.0.0.1:%s/transmission/rpc" % port
    request = Request(url, data=payload, headers=headers)
    try:
        return json.loads(urlopen(request, timeout=10).read())
    except HTTPError as error:
        if error.code != 409:
            raise
        headers["X-Transmission-Session-Id"] = error.headers["X-Transmission-Session-Id"]
        request = Request(url, data=payload, headers=headers)
        return json.loads(urlopen(request, timeout=10).read())


def tick(port, credential_file):
    user, password = credentials(credential_file)
    result = rpc(port, user, password, "torrent-get", {"fields": ["id", "labels", "files", "fileStats"]})
    for torrent in result.get("arguments", {}).get("torrents", []):
        labels = torrent.get("labels") or []
        markers = []
        for label in labels:
            match = MARKER.match(label)
            if match:
                markers.append((label, int(match.group(1))))
        if not markers:
            continue
        marker, index = markers[-1]
        files = torrent.get("files") or []
        stats = torrent.get("fileStats") or []
        if index >= len(files) or index >= len(stats):
            continue
        if stats[index].get("bytesCompleted", 0) < files[index].get("length", 0):
            continue
        all_files = list(range(len(files)))

        # Transmission 4 can acknowledge a combined torrent-set request while
        # applying only part of it. Keep the marker until every recovery step
        # has independently succeeded, so a later monitor pass can retry.
        rpc(port, user, password, "torrent-set", {
            "ids": [torrent["id"]], "files-wanted": all_files,
        })
        rpc(port, user, password, "torrent-set", {
            "ids": [torrent["id"]], "priority-normal": all_files,
        })

        verified = rpc(port, user, password, "torrent-get", {
            "ids": [torrent["id"]], "fields": ["fileStats"],
        })
        restored = verified.get("arguments", {}).get("torrents", [])
        restored_stats = restored[0].get("fileStats", []) if restored else []
        if len(restored_stats) < len(files) or not all(stat.get("wanted") for stat in restored_stats[:len(files)]):
            raise RuntimeError("Focus recovery did not restore all files for torrent %s" % torrent["id"])

        restored_labels = [label for label in labels if not MARKER.match(label)]
        rpc(port, user, password, "torrent-set", {
            "ids": [torrent["id"]], "labels": restored_labels,
        })
        sys.stderr.write("[TorrentStation] Focus recovery completed for torrent %s\\n" % torrent["id"])


def main():
    credential_file = sys.argv[1]
    port = sys.argv[2]
    while True:
        try:
            tick(port, credential_file)
        except Exception as error:
            # The worker must stay alive, but failures must be visible in the
            # normal Torrent Station log instead of leaving files in Skip.
            sys.stderr.write("[TorrentStation] Focus recovery error: %s\\n" % error)
        time.sleep(5)


if __name__ == "__main__":
    main()
