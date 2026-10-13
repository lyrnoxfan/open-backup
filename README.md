# Open Backup

GitHub Actions 定时备份：每天两次把指定仓库的完整 git 历史打成 `git bundle`，gzip 压缩后上传到你的 WebDAV，永不删除旧备份。

## 工作原理

```
定时触发（cron）→ git clone 完整历史 → git bundle create --all
  → gzip → curl PUT 到 WebDAV
```

- 备份文件：`<repo>-YYYYMMDD-HHMM.bundle.gz`
- 恢复：`gunzip` 后 `git clone <file>.bundle`
- 包一层 gzip 的原因：某些 WebDAV 服务对纯文本小文件 PUT 不友好，gzip 后最稳

## 快速开始

1. Fork 本仓库。
2. 在仓库 Settings → Secrets 里加：
   - `BACKUP_PAT`：有 `repo` 权限的 PAT（用来 clone 私有仓库）
   - `WEBDAV_USER` / `WEBDAV_PASS`：你的 WebDAV 账号密码
3. 改 `.github/workflows/backup.yml`：
   - 备份的仓库列表
   - WebDAV 上传地址（默认 `https://your-webdav.example.com/dav/backups/`）
   - 定时 cron（默认北京时间 00:00 / 12:00）

```yaml
# .github/workflows/backup.yml
REPOS="your-username/repo-a your-username/repo-b"
DAV_URL="https://your-webdav.example.com/dav/backups"
```

## 另外一个方案

`src/index.js` 是一个 Cloudflare Worker 版本：接收 GitHub webhook，流式转发到 WebDAV，适合不想等 cron 的场景。按文件头注释配置环境变量即可。

## 说明

- 备份频率和保留策略自己定，默认永不删除，注意磁盘增长。
- 仓库 Secrets 的值不要进代码。

MIT License.
