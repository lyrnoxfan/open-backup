#!/usr/bin/env python3
"""Deploy an ES module Worker via the Cloudflare API (multipart script upload).

Usage: deploy_worker.py <account_id> <script_name> <js_path>
Uses the stored custom.cloudflare credential via surrogate; never prints keys.
"""
import json
import sys
import urllib.request
import uuid

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

CRED = "custom.cloudflare"
ALLOWED = ("api.cloudflare.com",)


def api(method, path, body=None, content_type=None):
    url = f"https://api.cloudflare.com{path}"
    req = urllib.request.Request(url, data=body, method=method)
    if content_type:
        req.add_header("Content-Type", content_type)
    add_surrogate_to_request(req, CRED, allowed_hosts=ALLOWED)
    resp = urllib.request.urlopen(req, timeout=120)
    return read_json_response(resp)


def main() -> int:
    account_id, script_name, js_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(js_path, "rb") as f:
        js = f.read()

    boundary = uuid.uuid4().hex
    metadata = {
        "main_module": "index.js",
        "compatibility_date": "2026-10-04",
        "bindings": [
            {"type": "plain_text", "name": "WEBDAV_USER", "text": "lyrnox"},
            {"type": "plain_text", "name": "KEEP", "text": "4"},
        ],
    }

    parts = []

    def add_part(name, filename, ctype, data: bytes):
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
        )
        parts.append(f"Content-Type: {ctype}\r\n\r\n".encode())
        parts.append(data)
        parts.append(b"\r\n")

    add_part("metadata", "metadata.json", "application/json", json.dumps(metadata).encode())
    add_part("index.js", "index.js", "application/javascript+module", js)
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)

    print("== uploading script ==", flush=True)
    res = api(
        "PUT",
        f"/client/v4/accounts/{account_id}/workers/scripts/{script_name}",
        body,
        f"multipart/form-data; boundary={boundary}",
    )
    print("upload success:", res.get("success"))
    if not res.get("success"):
        print(json.dumps(res.get("errors"), indent=2, ensure_ascii=False)[:2000])
        return 1

    print("== setting cron schedule ==", flush=True)
    # 注意：官方文档要求 body 是裸数组 [{"cron": "..."}]，不是 {"crons": [...]}
    # 免费版账号最多 5 个 cron trigger，超限会报 10072
    res = api(
        "PUT",
        f"/client/v4/accounts/{account_id}/workers/scripts/{script_name}/schedules",
        json.dumps([{"cron": "0 18 * * *"}]).encode(),  # 每天 02:00（北京时间）
        "application/json",
    )
    print("schedules:", json.dumps(res.get("result"), ensure_ascii=False)[:500])
    return 0 if res.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
