import assert from "node:assert/strict";
import test from "node:test";
import { findPairAddress } from "../connection.mjs";

const status = { BackendState: "Running", Self: { DNSName: "prismo.tail.example." } };
const serve = {
  Web: { "prismo.tail.example:443": { Handlers: {
    "/": { Proxy: "http://127.0.0.1:3000/" }
  } } },
  AllowFunnel: {}
};
test("creates a pairing address only for a configured private HTTPS proxy", () => {
  assert.equal(findPairAddress(status, serve), "https://prismo.tail.example");
  assert.equal(findPairAddress({ ...status, BackendState: "Stopped" }, serve), null);
  assert.equal(findPairAddress({ BackendState: "Running" }, serve), null);
  assert.equal(findPairAddress(status, { Web: {} }), null);
  assert.equal(findPairAddress(status, { Web: {
    "prismo.tail.example:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8080/" } } }
  } }), null);
  assert.equal(findPairAddress(status, {
    ...serve, AllowFunnel: { "prismo.tail.example:443": true }
  }), null);
});
