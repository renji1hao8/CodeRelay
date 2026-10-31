import http from "node:http";
// Configure once, before backend requests. Node's fetch does not inherit the
// Windows system proxy. Loopback traffic must continue to bypass the proxy.
const proxy = process.env.REMOTE_CC_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || "";
const configure = (http as unknown as { setGlobalProxyFromEnv?: (env: Record<string, string>) => unknown }).setGlobalProxyFromEnv;
if (proxy || process.env.HTTP_PROXY || process.env.http_proxy) configure?.({
  http_proxy: process.env.HTTP_PROXY || process.env.http_proxy || proxy,
  https_proxy: proxy,
  no_proxy: [process.env.NO_PROXY || process.env.no_proxy, "localhost", "127.0.0.1", "::1"].filter(Boolean).join(","),
});
