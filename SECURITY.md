# 安全策略 / Security Policy

## 支持的版本 / Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## 报告漏洞 / Reporting a Vulnerability

请**不要**在公开 issue 中披露安全漏洞。请通过 GitHub 的私有漏洞报告功能
（仓库页面 → Settings → Security → **Report a vulnerability**）提交，或直接联系维护者。

请勿在报告中包含任何真实 API Key。

Please **do not** disclose vulnerabilities in public issues. Report them via
GitHub's private vulnerability reporting feature
（repository → Settings → Security → **Report a vulnerability**）, or contact
the maintainer directly. Never include real API keys in reports.

## 安全说明 / Security Notes

- 本工具为本地单机工具，服务默认只监听 `127.0.0.1`，不对局域网/公网开放。
- API Key 以明文保存在本地 SQLite（`data/agnes-console.db`）中，仅用于服务端调用 Agnes API，
  浏览器端永远只能看到掩码。请勿将 `data/` 目录或数据库文件提交到任何仓库。
- 请使用最小权限的 API Key，并定期轮换。