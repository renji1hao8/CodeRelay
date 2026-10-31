# 不用域名的受信任 HTTPS

Let’s Encrypt 自 2026 年 1 月起正式提供公网 IP 地址证书，支持 IPv4 和 IPv6。有效期为 **160 小时**（6 天 16 小时），必须自动续期。它可以替换自签证书，公开 APK 无需内置个人 CA。

需要可控制且可从公网验证的 IP。私网地址不能直接申请这种公有证书。IP 证书不支持 DNS-01；使用 HTTP-01（80 端口）或客户端支持的 TLS-ALPN-01（443 端口）。CodeRelay 自身仍只监听本机，由公网服务器上的 HTTPS 反向代理经私有隧道连接。

## Certbot / Nginx 示例

以下适用于已配置 Nginx 的 Linux 公网服务器。请将 `203.0.113.10` 换成实际公网 IP。安装官方当前版本 Certbot；IP 参数与 webroot 模式需要 Certbot 5.4 或更高版本。

在公网 80 端口的默认站点保留验证目录：

```nginx
location /.well-known/acme-challenge/ {
    root /var/www/acme;
    default_type text/plain;
}
```

先创建目录，确认公网访问该目录不被防火墙或其他代理拦截，再测试签发：

```sh
sudo mkdir -p /var/www/acme
sudo certbot certonly --staging --webroot -w /var/www/acme \
  --preferred-profile shortlived --ip-address 203.0.113.10
```

测试成功后，去掉 `--staging` 申请生产证书。按 Certbot 输出的实际证书名称配置 Nginx 的 `ssl_certificate` 与 `ssl_certificate_key`（通常位于 `/etc/letsencrypt/live/<证书名>/`），运行 `nginx -t` 后重载。

确保自动续期定时器已启用，至少每天检查两次，并配置成功续期后的部署钩子：

```sh
sudo certbot reconfigure --cert-name <证书名> \
  --deploy-hook 'nginx -t && systemctl reload nginx'
sudo certbot renew --cert-name <证书名> --dry-run
```

演练使用测试 CA，不替换线上证书。首次切换也应备份站点配置，核对证书 SAN 中的 IP 和证书链，再验证 `https://实际公网IP:你的HTTPS端口/api/health`；不要用跳过校验参数来判断是否成功。证书验证使用 80 或 443，App 的 HTTPS 服务可以使用另一个端口。

如果该 IP 已有自动续期的同用途公有证书，可让多个 Nginx 站点引用同一组证书路径；成功续期后的 Nginx 重载会更新这些入口。应由证书的原管理任务统一续期，避免重复签发。

官方资料：[正式支持公告](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability) · [Certbot IP 证书教程](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)。
