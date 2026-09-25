import { createHash } from "node:crypto";
import http from "node:http";

export function expoPreviewPrefix(secret) {
  return (
    "/__expo/" +
    createHash("sha256")
      .update("expo-preview:" + secret)
      .digest("hex")
      .slice(0, 32)
  );
}

// A narrowly scoped, read-only Metro entry point. No inspector, command, or
// filesystem endpoints are published. The link is a bearer credential.
export function createExpoPreviewProxy(secret) {
  const prefix = expoPreviewPrefix(secret);
  return function proxyExpo(req, res, url) {
    if (!url.pathname.startsWith("/__expo/")) return false;
    const tail = url.pathname.slice(prefix.length);
    if (
      !url.pathname.startsWith(prefix + "/") ||
      !["GET", "HEAD"].includes(req.method) ||
      !(
        tail === "/" ||
        /^\/[\w./@%-]+\.bundle$/.test(tail) ||
        tail.startsWith("/assets/")
      ) ||
      tail.includes("..") ||
      /%2e|%2f|%5c/i.test(tail)
    ) {
      res.writeHead(404);
      res.end();
      return true;
    }
    // Expo --localhost binds ::1 on this Windows host; resolve localhost rather
    // than forcing IPv4, which otherwise produces a connection-refused 502.
    const target = new URL("http://localhost:8081" + tail + url.search);
    if (tail.endsWith(".bundle")) target.searchParams.set("lazy", "false");
    const headers = {
      "expo-platform": req.headers["expo-platform"] ?? "ios",
      accept: "application/expo+json",
      host: "127.0.0.1:8081",
    };
    const upstream = http.get(target, { headers }, (response) => {
      if (tail !== "/" || response.statusCode !== 200) {
        res.writeHead(response.statusCode ?? 502, {
          "content-type":
            response.headers["content-type"] ?? "application/octet-stream",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        if (req.method === "HEAD") {
          response.resume();
          res.end();
        } else response.pipe(res);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024)
          upstream.destroy(new Error("Manifest too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const manifest = JSON.parse(Buffer.concat(chunks).toString());
          const base = "https://atlas-dev.sightings.today" + prefix;
          const rewrite = (value) => {
            const parsed = new URL(value);
            return base + parsed.pathname + parsed.search;
          };
          manifest.launchAsset.url = rewrite(manifest.launchAsset.url);
          const bundle = new URL(manifest.launchAsset.url);
          bundle.searchParams.set("lazy", "false");
          manifest.launchAsset.url = bundle.href;
          for (const asset of manifest.assets ?? [])
            asset.url = rewrite(asset.url);
          if (manifest.extra?.expoClient) {
            delete manifest.extra.expoClient._internal;
            manifest.extra.expoClient.hostUri = base.slice(8);
            if (manifest.extra.expoClient.iconUrl)
              manifest.extra.expoClient.iconUrl = rewrite(
                manifest.extra.expoClient.iconUrl,
              );
          }
          if (manifest.extra?.expoGo) {
            manifest.extra.expoGo.debuggerHost = base.slice(8);
            delete manifest.extra.expoGo.developer;
          }
          // Expo Go distinguishes modern update manifests from legacy manifests
          // using these headers, not the JSON content type or shape alone.
          const protocolHeaders = {};
          for (const name of ["expo-protocol-version", "expo-sfv-version"]) {
            if (response.headers[name] !== undefined)
              protocolHeaders[name] = response.headers[name];
          }
          res.writeHead(200, {
            ...protocolHeaders,
            "content-type": "application/expo+json",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          });
          res.end(req.method === "HEAD" ? undefined : JSON.stringify(manifest));
        } catch {
          res.writeHead(502);
          res.end("Expo manifest unavailable");
        }
      });
    });
    upstream.setTimeout(120000, () =>
      upstream.destroy(new Error("Metro timeout")),
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(503);
        res.end("Expo preview is starting");
      } else res.destroy();
    });
    return true;
  };
}
