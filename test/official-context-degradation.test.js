const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { state } = require("../payload/extension/out/byok/config/state");
const { resolveOfficialContextConnection } = require("../payload/extension/out/byok/runtime/official/common");
const { maybeInjectOfficialCodebaseRetrieval } = require("../payload/extension/out/byok/runtime/official/codebase-retrieval");
const { maybeInjectOfficialContextCanvas } = require("../payload/extension/out/byok/runtime/official/context-canvas");
const { maybeInjectOfficialExternalSources } = require("../payload/extension/out/byok/runtime/official/external-sources");

async function withOfficialConfig(official, fn) {
  const previous = state.configManager;
  state.configManager = { get: () => ({ official }) };
  try {
    return await fn();
  } finally {
    state.configManager = previous;
  }
}

async function captureWarn(fn) {
  const previous = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args.map((x) => String(x)).join(" "));
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.warn = previous;
  }
}

function startCountingServer() {
  return new Promise((resolve) => {
    let count = 0;
    const server = http.createServer((req, res) => {
      count += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        getCount: () => count,
        baseUrl: `http://127.0.0.1:${addr.port}/`
      });
    });
  });
}

function startOfficialJsonServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const body = bodyText ? JSON.parse(bodyText) : {};
        requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || "", body });
        const payload = handler({ req, body, requests });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        requests,
        baseUrl: `http://127.0.0.1:${addr.port}/`
      });
    });
  });
}

test("official context injection: missing token emits visible degradation warning", async () => {
  await withOfficialConfig({ completionUrl: "https://official.invalid/base", apiToken: "" }, async () => {
    const feature = `test-missing-token-${Date.now()}`;
    const { result, calls } = await captureWarn(() => resolveOfficialContextConnection({ feature }));

    assert.equal(result, null);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /official context injection skipped/);
    assert.match(calls[0], new RegExp(`feature=${feature}`));
    assert.match(calls[0], /degraded=true/);
    assert.match(calls[0], /network=skipped/);
    assert.match(calls[0], /official\.apiToken/);
    assert.match(calls[0], /official\.completionUrl and official\.apiToken/);
    assert.match(calls[0], /BYOK chat continues without this official context/);
    assert.doesNotMatch(calls[0], /Bearer|secret-value|official-token/);
  });
});

test("official context injection: upstream URL object is used after runtime boundary", async () => {
  await withOfficialConfig({ completionUrl: "https://configured.invalid/base", apiToken: "configured-token" }, async () => {
    const upstreamUrl = new URL("https://upstream.example/base/");
    const conn = resolveOfficialContextConnection({
      feature: `test-url-object-${Date.now()}`,
      upstreamCompletionURL: upstreamUrl,
      upstreamApiToken: "Bearer upstream-token"
    });

    assert.deepEqual(conn, { completionURL: upstreamUrl.href, apiToken: "upstream-token" });
  });
});

test("official context injection: warning is emitted once per feature/missing set", async () => {
  await withOfficialConfig({ completionUrl: "https://official.invalid/base", apiToken: "" }, async () => {
    const feature = `test-once-${Date.now()}`;
    const { result, calls } = await captureWarn(async () => {
      const first = resolveOfficialContextConnection({ feature });
      const second = resolveOfficialContextConnection({ feature });
      return { first, second };
    });

    assert.equal(result.first, null);
    assert.equal(result.second, null);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /network=skipped/);
  });
});

test("official codebase retrieval: missing token skips before network path", async () => {
  await withOfficialConfig({ completionUrl: "https://official.invalid/base", apiToken: "" }, async () => {
    const req = {
      message: "find relevant code",
      blobs: { checkpoint_id: "cp1", added_blobs: ["src/a.js"], deleted_blobs: [] },
      nodes: []
    };

    const { result } = await captureWarn(() => maybeInjectOfficialCodebaseRetrieval({ req, timeoutMs: 1000 }));
    assert.equal(result, false);
    assert.deepEqual(req.nodes, []);
  });
});

test("official context injection: disableRetrieval skips before degradation warning and network", async () => {
  await withOfficialConfig({ completionUrl: "https://official.invalid/base", apiToken: "" }, async () => {
    const { server, baseUrl, getCount } = await startCountingServer();
    try {
      const codebaseReq = {
        message: "find relevant code",
        disableRetrieval: true,
        blobs: { checkpoint_id: "cp1", added_blobs: ["src/a.js"], deleted_blobs: [] },
        nodes: []
      };
      const canvasReq = { disableRetrieval: true, canvas_id: "canvas-1", nodes: [] };
      const externalReq = { disableRetrieval: true, message: "find sources", nodes: [] };

      const { result, calls } = await captureWarn(async () => ({
        codebase: await maybeInjectOfficialCodebaseRetrieval({ req: codebaseReq, timeoutMs: 1000, upstreamCompletionURL: baseUrl }),
        canvas: await maybeInjectOfficialContextCanvas({ req: canvasReq, timeoutMs: 1000, upstreamCompletionURL: baseUrl }),
        external: await maybeInjectOfficialExternalSources({ req: externalReq, timeoutMs: 1000, upstreamCompletionURL: baseUrl })
      }));

      assert.deepEqual(result, { codebase: false, canvas: false, external: false });
      assert.deepEqual(codebaseReq.nodes, []);
      assert.deepEqual(canvasReq.nodes, []);
      assert.deepEqual(externalReq.nodes, []);
      assert.equal(getCount(), 0);
      assert.deepEqual(calls, []);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("official context canvas: missing token skips before network path", async () => {
  await withOfficialConfig({ completionUrl: "https://official.invalid/base", apiToken: "" }, async () => {
    const { server, baseUrl, getCount } = await startCountingServer();
    try {
      const req = { canvas_id: "canvas-1", nodes: [] };
      const { result, calls } = await captureWarn(() =>
        maybeInjectOfficialContextCanvas({ req, timeoutMs: 1000, upstreamCompletionURL: baseUrl })
      );

      assert.equal(result, false);
      assert.deepEqual(req.nodes, []);
      assert.equal(getCount(), 0);
      assert.equal(calls.length, 1);
      assert.match(calls[0], /feature=context-canvas/);
      assert.match(calls[0], /official\.apiToken/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("official external sources: missing token skips before network path", async () => {
  await withOfficialConfig({ completionUrl: "https://official.invalid/base", apiToken: "" }, async () => {
    const { server, baseUrl, getCount } = await startCountingServer();
    try {
      const req = { message: "find sources", nodes: [] };
      const { result, calls } = await captureWarn(() =>
        maybeInjectOfficialExternalSources({ req, timeoutMs: 1000, upstreamCompletionURL: baseUrl })
      );

      assert.equal(result, false);
      assert.deepEqual(req.nodes, []);
      assert.equal(getCount(), 0);
      assert.equal(calls.length, 1);
      assert.match(calls[0], /feature=external-sources/);
      assert.match(calls[0], /official\.apiToken/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("official external sources: auto path uses current search endpoint", async () => {
  const { server, baseUrl, requests } = await startOfficialJsonServer(({ req }) => {
    assert.equal(req.url, "/search-external-sources");
    return {
      sources: [
        {
          id: "source-1",
          title: "Relevant Doc",
          url: "https://docs.example/source-1",
          source_type: "doc",
          snippet: "external source snippet"
        }
      ]
    };
  });

  try {
    await withOfficialConfig({ completionUrl: baseUrl, apiToken: "official-token" }, async () => {
      const req = { message: "find sources", nodes: [] };
      const injected = await maybeInjectOfficialExternalSources({ req, timeoutMs: 4000 });

      assert.equal(injected, true);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "/search-external-sources");
      assert.equal(requests[0].authorization, "Bearer official-token");
      assert.equal(requests[0].body.query, "find sources");
      assert.ok(req.nodes.some((n) => typeof n?.text_node?.content === "string" && n.text_node.content.includes("[EXTERNAL_SOURCES]")));
      assert.ok(req.nodes.some((n) => typeof n?.text_node?.content === "string" && n.text_node.content.includes("external source snippet")));
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("official context injection: disableContextInjection config skips network", async () => {
  await withOfficialConfig(
    { completionUrl: "https://official.invalid/base", apiToken: "secret-token", disableContextInjection: true },
    async () => {
      const { server, baseUrl, getCount } = await startCountingServer();
      try {
        const codebaseReq = {
          message: "find relevant code",
          blobs: { checkpoint_id: "cp1", added_blobs: ["src/a.js"], deleted_blobs: [] },
          nodes: []
        };
        const canvasReq = { canvas_id: "canvas-1", nodes: [] };
        const externalReq = { message: "find sources", nodes: [] };

        const { result, calls } = await captureWarn(async () => ({
          codebase: await maybeInjectOfficialCodebaseRetrieval({ req: codebaseReq, timeoutMs: 1000, upstreamCompletionURL: baseUrl, upstreamApiToken: "secret-token" }),
          canvas: await maybeInjectOfficialContextCanvas({ req: canvasReq, timeoutMs: 1000, upstreamCompletionURL: baseUrl, upstreamApiToken: "secret-token" }),
          external: await maybeInjectOfficialExternalSources({ req: externalReq, timeoutMs: 1000, upstreamCompletionURL: baseUrl, upstreamApiToken: "secret-token" })
        }));

        assert.deepEqual(result, { codebase: false, canvas: false, external: false });
        assert.equal(getCount(), 0);
        // Config kill-switch should not emit token-missing degradation warnings.
        assert.deepEqual(calls, []);
      } finally {
        await new Promise((r) => server.close(r));
      }
    }
  );
});

test("getOfficialConnection exposes disableContextInjection", async () => {
  const { getOfficialConnection } = require("../payload/extension/out/byok/config/official");
  await withOfficialConfig({ completionUrl: "https://x.example/", apiToken: "tok", disableContextInjection: true }, async () => {
    const conn = getOfficialConnection();
    assert.equal(conn.disableContextInjection, true);
    assert.equal(conn.apiToken, "tok");
  });
});

