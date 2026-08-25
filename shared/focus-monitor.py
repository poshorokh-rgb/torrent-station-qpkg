#!/usr/bin/env python3
"""Restore files paused by Torrent Station's Focus-download mode.

The marker lives in a Transmission label, so this worker survives browser
closures and NAS restarts.  It removes the marker and resumes the remaining
files once the focused file reaches 100%.
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
        restored_labels = [label for label in labels if not MARKER.match(label)]
        all_files = list(range(len(files)))
        rpc(port, user, password, "torrent-set", {
            "ids": [torrent["id"]], "labels": restored_labels,
            "files-wanted": all_files, "priority-normal": all_files,
        })


def main():
    credential_file = sys.argv[1]
    port = sys.argv[2]
    while True:
        try:
            tick(port, credential_file)
        except Exception:
            pass
        time.sleep(5)


if __name__ == "__main__":
    main()
