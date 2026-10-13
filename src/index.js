// auto-backup-worker
// 每天定时把 your-username/repo-a 和 your-username/repo-b 的 HEAD 快照
// 打包成 tar.gz，上传到 https://your-webdav.example.com/dav/ ，每个仓库只保留最近 KEEP 份。
//
// 需要的 Secrets（在 Cloudflare Dashboard 设置，不在代码里）：
//   GITHUB_TOKEN  - 有这两个仓库 contents:read 权限的 token（fine-grained PAT）
//   WEBDAV_PASS   - your-webdav.example.com/dav 的密码
//   TRIGGER_KEY   - 可选，手动触发 /run?key=... 用的口令
// 普通变量：WEBDAV_USER（默认 your-username）、KEEP（默认 4）

const OWNER = "your-username";
const REPOS = ["AstroPages", "Blog-APK"];
const DAV_BASE = "https://your-webdav.example.com/dav";

function basicAuth(user, pass) {
  const bytes = new TextEncoder().encode(user + ":" + pass);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "Basic " + btoa(bin);
}

// 北京时间的 YYYYMMDD
function todayStr() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return g("year") + g("month") + g("day");
}

// 拿 GitHub tarball 下载地址（api 返回 302 跳到 codeload，手动跟一次，
// 避免 Authorization 头在跨域跳转时被剥掉）
async function githubTarballUrl(repo, env) {
  const api = `https://api.github.com/repos/${OWNER}/${repo}/tarball/main`;
  const r = await fetch(api, {
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "auto-backup-worker",
      Accept: "application/vnd.github+json",
    },
  });
  if ([301, 302, 303, 307, 308].includes(r.status)) {
    const loc = r.headers.get("location");
    if (r.body) await r.body.cancel().catch(() => {});
    if (!loc) throw new Error(`github redirect without location for ${repo}`);
    return loc;
  }
  const t = await r.text();
  throw new Error(`github api ${r.status} for ${repo}: ${t.slice(0, 200)}`);
}

async function backupRepo(repo, env, date, auth) {
  const url = await githubTarballUrl(repo, env);
  const src = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "auto-backup-worker",
    },
  });
  if (!src.ok || !src.body) throw new Error(`download ${repo}: ${src.status}`);

  const name = `${repo}-${date}.tar.gz`;
  const contentLength = src.headers.get("content-length");
  const headers = { Authorization: auth, "Content-Type": "application/gzip" };
  if (contentLength) headers["Content-Length"] = contentLength;

  // 流式转发：GitHub -> WebDAV，不在 Worker 里落盘
  const put = await fetch(`${DAV_BASE}/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers,
    body: src.body,
    duplex: "half",
  });
  const text = await put.text();
  if (![200, 201, 204].includes(put.status)) {
    throw new Error(`upload ${name}: ${put.status} ${text.slice(0, 200)}`);
  }
  return { file: name, bytes: contentLength ? Number(contentLength) : null };
}

async function listBackups(auth) {
  const r = await fetch(`${DAV_BASE}/`, {
    method: "PROPFIND",
    headers: {
      Authorization: auth,
      Depth: "1",
      "Content-Type": "application/xml",
    },
    body: `<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><displayname/></prop></propfind>`,
  });
  const xml = await r.text();
  if (!r.ok) throw new Error(`list webdav: ${r.status} ${xml.slice(0, 200)}`);
  const names = [];
  const re = /<[^>]*href>([^<]*)<\/[^>]*href>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const base = decodeURIComponent(m[1]).split("/").filter(Boolean).pop();
    if (base && /^[A-Za-z0-9_-]+-\d{8}\.tar\.gz$/.test(base)) names.push(base);
  }
  return names;
}

async function enforceRetention(env, auth) {
  const keep = parseInt(env.KEEP || "4", 10);
  const names = await listBackups(auth);
  const groups = {};
  for (const n of names) {
    const mm = n.match(/^([A-Za-z0-9_-]+)-(\d{8})\.tar\.gz$/);
    if (!mm) continue;
    (groups[mm[1]] = groups[mm[1]] || []).push({ name: n, date: mm[2] });
  }
  const deleted = [];
  for (const repo of Object.keys(groups)) {
    const sorted = groups[repo].sort((a, b) => b.date.localeCompare(a.date));
    for (const old of sorted.slice(keep)) {
      const del = await fetch(`${DAV_BASE}/${encodeURIComponent(old.name)}`, {
        method: "DELETE",
        headers: { Authorization: auth },
      });
      await del.text().catch(() => {});
      if ([200, 202, 204].includes(del.status)) deleted.push(old.name);
      else deleted.push(old.name + ` (delete -> ${del.status})`);
    }
  }
  return { keptPerRepo: keep, deleted };
}

async function runBackup(env) {
  const t0 = Date.now();
  if (!env.GITHUB_TOKEN) throw new Error("missing secret GITHUB_TOKEN");
  if (!env.WEBDAV_PASS) throw new Error("missing secret WEBDAV_PASS");
  const auth = basicAuth(env.WEBDAV_USER || "your-username", env.WEBDAV_PASS);
  const date = todayStr();
  const result = { date, repos: {} };
  for (const repo of REPOS) {
    try {
      result.repos[repo] = { ok: true, ...(await backupRepo(repo, env, date, auth)) };
    } catch (e) {
      result.repos[repo] = { ok: false, error: String((e && e.message) || e) };
    }
  }
  try {
    result.retention = await enforceRetention(env, auth);
  } catch (e) {
    result.retention = { error: String((e && e.message) || e) };
  }
  result.elapsedMs = Date.now() - t0;
  return result;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runBackup(env).then(
        (r) => console.log("backup done", JSON.stringify(r)),
        (e) => console.log("backup failed", String((e && e.message) || e)),
      ),
    );
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      if (!env.TRIGGER_KEY || url.searchParams.get("key") !== env.TRIGGER_KEY) {
        return new Response("forbidden\n", { status: 403 });
      }
      return Response.json(await runBackup(env));
    }
    return new Response(
      "auto-backup worker\n" +
        "- cron: daily 02:00 (Asia/Shanghai)\n" +
        "- repos: my-blog, my-app -> https://your-webdav.example.com/dav/<repo>-YYYYMMDD.tar.gz\n" +
        "- manual: /run?key=TRIGGER_KEY\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};
