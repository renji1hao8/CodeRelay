/** Pair-code generation and elevation requests remain local even in LAN mode. */
export function acceptsNetworkRequest(loopback: boolean, requestPath: string, listenHost: string): boolean {
  if (loopback) return true;
  if (listenHost === "127.0.0.1" || listenHost === "::1" || listenHost === "localhost") return false;
  return !["/api/pair/start", "/api/elevated/request"].includes(requestPath);
}
