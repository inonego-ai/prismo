export function findPairAddress(status, serve) {
  const dns = status?.Self?.DNSName?.replace(/\.$/, "").toLowerCase();
  if (status?.BackendState !== "Running" || !dns) return null;
  const web = serve?.Web;
  if (!web || typeof web !== "object") return null;
  for (const [address, entry] of Object.entries(web)) {
    const host = address.replace(/:443$/, "").toLowerCase();
    if (host !== dns || !address.endsWith(":443")) continue;
    const handler = entry?.Handlers?.["/"];
    const proxy = handler?.Proxy;
    if (typeof proxy !== "string") continue;
    let target;
    try { target = new URL(proxy); } catch { continue; }
    if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname)
      || target.port !== "3000" || target.pathname !== "/") continue;
    if (serve?.AllowFunnel?.[address]) return null;
    return "https://" + dns;
  }
  return null;
}