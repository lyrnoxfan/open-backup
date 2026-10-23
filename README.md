# Open Backup

GitHub Actions 定时备份：每天两次把指定仓库的完整 git 历史打成 `git bundle`，gzip 压缩后上传到你的 WebDAV，永不删除旧备份。

## 工作原理

```
定时触发（cron）→ 校验必填配置 → clone 完整历史 → git bundle（全部分支 + 标签）
  → gzip → PUT 到 WebDAV（检查 HTTP 状态）→ 立刻下载回来
  → 校验 sha256 → git bundle verify → 恢复成镜像仓库并逐个比对分支/标签 SHA
```

- 备份文件：`<repo>-YYYYMMDD-HHMM.bundle.gz`，旁边附 `.manifest.json`（源仓库、HEAD 提交 SHA、全部 ref、文件 sha256）
- 任何一步失败（上传非 2xx、回读不一致、恢复后 ref 对不上）都会让对应仓库的任务失败，不会"假绿"
- 恢复：`gunzip` 后 `git clone <file>.bundle`
- 包一层 gzip 的原因：某些 WebDAV 服务对小的裸二进制 PUT 不友好，gzip 后最稳

## 快速开始

1. Fork 本仓库。
2. Settings → Secrets and variables → Actions：
   - **Variables**
     - `BACKUP_SOURCE_OWNER`：被备份仓库的所有者（用户名或组织）
     - `WEBDAV_URL`：上传目录，必须是 `https://`，如 `https://dav.your-domain/dav/backups`
   - **Secrets**
     - `BACKUP_PAT`：有 `repo` 读权限的 PAT（clone 私有仓库）
     - `WEBDAV_USER` / `WEBDAV_PASS`：WebDAV 账号密码
3. 在 `.github/workflows/backup.yml` 的 `matrix.repo` 里改要备份的仓库名，按需改 cron。
4. Actions 页面手动 Run workflow 跑一次，确认每个仓库都走完"上传 + 回读恢复"。

缺任何一项配置，或仍是示例值（`your-username`、`example.com`），工作流会在第一步直接报错。

## 另外一个方案

`src/index.js` 是一个 Cloudflare Worker 版本：接收 GitHub webhook，流式转发到 WebDAV，适合不想等 cron 的场景。按文件头注释配置环境变量即可。

## 说明

- 备份频率和保留策略自己定，默认永不删除，注意磁盘增长。
- 仓库 Secrets 的值不要进代码。

MIT License.
