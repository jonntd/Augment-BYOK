const test = require("node:test");
const assert = require("node:assert/strict");

const { audit, redactText } = require("../payload/extension/out/byok/infra/log");

test("redactText: Bearer token", () => {
  const token = "sk-proj-1234567890abcdef1234567890abcdef";
  const input = `Authorization: Bearer ${token}`;
  const out = redactText(input);
  assert.equal(out, "Authorization: Bearer ***");
  assert.ok(!out.includes("sk-proj-"));
});

test("redactText: sk-ant-...", () => {
  const input = "sk-ant-1234567890abcdef1234567890abcdef";
  const out = redactText(input);
  assert.equal(out, "sk-ant-***");
});

test("redactText: sk-proj-...", () => {
  const input = "sk-proj-1234567890abcdef1234567890abcdef";
  const out = redactText(input);
  assert.equal(out, "sk-proj-***");
});

test("redactText: sk-... (supports -/_)", () => {
  const input = "sk-1234_abcd-efgh5678ijkl";
  const out = redactText(input);
  assert.equal(out, "sk-***");
});

test("redactText: ace_...", () => {
  const input = "ace_1234567890abcdef";
  const out = redactText(input);
  assert.equal(out, "ace_***");
});

test("redactText: does not redact normal text", () => {
  const input = "mask-proj-1234 is not a token; sk-1234 too short";
  const out = redactText(input);
  assert.equal(out, input);
});

test("redactText: query tokens and Google API keys", () => {
  const input = "https://example.test/path?token=abc123&apiToken=AIzaSyA1234567890abcdefghijklmnop key=AIzaSyB1234567890abcdefghijklmnop";
  const out = redactText(input);
  assert.equal(out, "https://example.test/path?token=***&apiToken=*** key=AIza***");
  assert.ok(!out.includes("abc123"));
  assert.ok(!out.includes("AIzaSyA1234567890"));
  assert.ok(!out.includes("AIzaSyB1234567890"));
});

test("redactText: URL/form sensitive parameters", () => {
  const input = [
    "https://gateway.example/v1?apiKey=camel-secret&clientSecret=client-secret&password=password-secret&authorization=Token%20auth-secret",
    "https://auth.example/callback#access_token=fragment-secret&refresh_token=refresh-secret",
    "grant_type=client_credentials&client_secret=form-client-secret&auth_token=form-auth-token;credential=form-credential",
    "body: client_secret=inline-client-secret credential=inline-credential"
  ].join("\n");
  const out = redactText(input);

  assert.match(out, /apiKey=\*\*\*/);
  assert.match(out, /clientSecret=\*\*\*/);
  assert.match(out, /password=\*\*\*/);
  assert.match(out, /authorization=\*\*\*/);
  assert.match(out, /#access_token=\*\*\*/);
  assert.match(out, /&refresh_token=\*\*\*/);
  assert.match(out, /&client_secret=\*\*\*/);
  assert.match(out, /&auth_token=\*\*\*/);
  assert.match(out, /;credential=\*\*\*/);
  assert.match(out, / client_secret=\*\*\*/);
  assert.match(out, / credential=\*\*\*/);
  assert.doesNotMatch(
    out,
    /camel-secret|client-secret|password-secret|auth-secret|fragment-secret|refresh-secret|form-client-secret|form-auth-token|form-credential|inline-client-secret|inline-credential/
  );
});

test("redactText: environment-style secrets and URL userinfo", () => {
  const input = [
    "OPENAI_API_KEY=env-openai-secret ANTHROPIC_AUTH_TOKEN=env-auth-secret GITHUB_TOKEN=env-github-secret MAX_TOKENS=4096",
    "OPENROUTER_API_KEY: router-secret",
    "https://user-secret:password-secret@gateway.example/v1/chat/completions"
  ].join("\n");
  const out = redactText(input);

  assert.match(out, /OPENAI_API_KEY=\*\*\*/);
  assert.match(out, /ANTHROPIC_AUTH_TOKEN=\*\*\*/);
  assert.match(out, /GITHUB_TOKEN=\*\*\*/);
  assert.match(out, /MAX_TOKENS=4096/);
  assert.match(out, /OPENROUTER_API_KEY: \*\*\*/);
  assert.match(out, /https:\/\/\*\*\*@gateway\.example\/v1\/chat\/completions/);
  assert.doesNotMatch(out, /env-openai-secret|env-auth-secret|env-github-secret|router-secret|user-secret|password-secret/);
});

test("redactText: sensitive header lines and json-like header strings", () => {
  const input = [
    "Authorization: Basic basic-secret-value",
    "Proxy-Authorization=Bearer proxy-secret-value",
    "Cookie: sid=secret; theme=dark",
    "x-api-key: header-secret",
    "api_key: snake-secret",
    "apiKey=camel-secret",
    "client_secret: client-secret-value",
    "password=plain-password-value",
    "helicone-auth: custom-auth-secret",
    "x-credential=custom-credential-secret",
    "Authorization: Token token-scheme-secret",
    "{\"authorization\":\"Bearer json-secret-value\",\"proxy-authorization\":\"Token json-token-scheme\",\"x-goog-api-key\":\"AIzaSyA1234567890abcdefghijklmnop\",\"clientSecret\":\"json-client-secret\",\"password\":\"json-password\",\"helicone-auth\":\"json-auth-secret\",\"x-credential\":\"json-credential-secret\"}"
  ].join("\n");
  const out = redactText(input);

  assert.match(out, /Authorization: Basic \*\*\*/);
  assert.match(out, /Proxy-Authorization=Bearer \*\*\*/);
  assert.match(out, /Cookie: \*\*\*/);
  assert.match(out, /x-api-key: \*\*\*/);
  assert.match(out, /api_key: \*\*\*/);
  assert.match(out, /apiKey=\*\*\*/);
  assert.match(out, /client_secret: \*\*\*/);
  assert.match(out, /password=\*\*\*/);
  assert.match(out, /helicone-auth: \*\*\*/);
  assert.match(out, /x-credential=\*\*\*/);
  assert.match(out, /Authorization: \*\*\*/);
  assert.match(out, /"authorization":"\*\*\*"/);
  assert.match(out, /"proxy-authorization":"\*\*\*"/);
  assert.match(out, /"x-goog-api-key":"\*\*\*"/);
  assert.match(out, /"clientSecret":"\*\*\*"/);
  assert.match(out, /"password":"\*\*\*"/);
  assert.match(out, /"helicone-auth":"\*\*\*"/);
  assert.match(out, /"x-credential":"\*\*\*"/);
  assert.doesNotMatch(
    out,
    /basic-secret-value|proxy-secret-value|sid=secret|header-secret|snake-secret|camel-secret|client-secret-value|plain-password-value|custom-auth-secret|custom-credential-secret|token-scheme-secret|json-token-scheme|json-secret-value|json-client-secret|json-password|json-auth-secret|json-credential-secret|AIzaSyA1234567890/
  );
});

test("redactText: quoted inline authorization values with schemes do not leak credentials", () => {
  const input = [
    'request authorization="Basic dXNlcjpwYXNz" next=ok',
    "request proxy-authorization='Bearer bearer-inline-secret' next=ok"
  ].join("\n");
  const out = redactText(input);

  assert.match(out, /authorization=\*\*\*/);
  assert.match(out, /proxy-authorization=\*\*\*/);
  assert.match(out, /next=ok/);
  assert.doesNotMatch(out, /dXNlcjpwYXNz|bearer-inline-secret/);
});

test("redactText: json-like apiKey aliases with non-sk secrets", () => {
  const input = JSON.stringify({
    apiKey: "gemini-secret-value",
    api_key: "snake-secret-value",
    apikey: "flat-secret-value"
  });
  const out = redactText(input);

  assert.match(out, /"apiKey":"\[redacted\]"/);
  assert.match(out, /"api_key":"\[redacted\]"/);
  assert.match(out, /"apikey":"\[redacted\]"/);
  assert.doesNotMatch(out, /gemini-secret-value|snake-secret-value|flat-secret-value/);
});

test("redactText: parses whole JSON strings with nested token/header aliases", () => {
  const input = JSON.stringify({
    headers: {
      githubToken: "github-token-secret",
      "x-provider-token": "provider-token-secret",
      authorization: "Bearer bearer-token-secret",
      metadata: "safe"
    },
    requestDefaults: { max_tokens: 4096 }
  });
  const out = redactText(input);

  assert.match(out, /"githubToken":"\[redacted\]"/);
  assert.match(out, /"x-provider-token":"\[redacted\]"/);
  assert.match(out, /"authorization":"\[redacted\]"/);
  assert.match(out, /"metadata":"safe"/);
  assert.match(out, /"max_tokens":4096/);
  assert.doesNotMatch(out, /github-token-secret|provider-token-secret|bearer-token-secret/);
});

test("redactText: omits tool arguments in stringified payloads", () => {
  const input = JSON.stringify({
    function: {
      name: "run_shell",
      arguments: "{\"cmd\":\"cat ~/.ssh/id_rsa\",\"token\":\"sk-proj-1234567890abcdef1234567890abcdef\"}"
    },
    tool_use: {
      input: { path: "/tmp/secret.txt", content: "file-secret-value" }
    },
    headers: {
      authorization: "Bearer sk-proj-1234567890abcdef1234567890abcdef"
    },
    max_tokens: 4096
  });
  const out = redactText(input);

  assert.match(out, /"arguments":"\[omitted arguments len=\d+\]"/);
  assert.match(out, /"input":"\[omitted input keys=\d+\]"/);
  assert.match(out, /"authorization":"\[redacted\]"/);
  assert.match(out, /"max_tokens":4096/);
  assert.doesNotMatch(out, /id_rsa|file-secret-value|sk-proj-/);
});

test("redactText: omits tool input inside embedded JSON fragments", () => {
  const input = [
    "upstream error detail:",
    JSON.stringify({
      tool_use: {
        name: "write_file",
        input: { path: "/tmp/secret.txt", content: "file-secret-value" }
      },
      max_tokens: 4096
    })
  ].join(" ");
  const out = redactText(input);

  assert.match(out, /upstream error detail:/);
  assert.match(out, /"input":"\[omitted input keys=\d+\]"/);
  assert.match(out, /"max_tokens":4096/);
  assert.doesNotMatch(out, /\/tmp\/secret\.txt|file-secret-value/);
});

test("redactText: omits inline tool argument assignments", () => {
  const input = [
    "tool arguments={\"cmd\":\"cat ~/.ssh/id_rsa\"}",
    "input_json={\"path\":\"/tmp/secret-json.txt\",\"content\":\"json-secret-value\"}",
    "partial_json: {\"cmd\":\"cat ~/.aws/credentials\"}",
    "MAX_TOKENS=4096"
  ].join("\n");
  const out = redactText(input);

  assert.match(out, /arguments=\[omitted arguments\]/);
  assert.match(out, /input_json=\[omitted input_json\]/);
  assert.match(out, /partial_json: \[omitted partial_json\]/);
  assert.match(out, /MAX_TOKENS=4096/);
  assert.doesNotMatch(out, /id_rsa|secret-json|json-secret-value|credentials/);
});

test("redactText: omits balanced inline JSON assignments with braces inside strings", () => {
  const input = [
    "arguments={\"cmd\":\"echo } secret-value\"} next=ok",
    "input_json={\"nested\":{\"cmd\":\"echo } nested-secret\"},\"list\":[\"a}\",\"array-secret\"]} tail=kept",
    "partial_json=[{\"cmd\":\"echo ] array-tail-secret\"}] done=yes"
  ].join("\n");
  const out = redactText(input);

  assert.match(out, /arguments=\[omitted arguments\] next=ok/);
  assert.match(out, /input_json=\[omitted input_json\] tail=kept/);
  assert.match(out, /partial_json=\[omitted partial_json\] done=yes/);
  assert.doesNotMatch(out, /secret-value|nested-secret|array-secret|array-tail-secret/);
});

test("audit: omits tool arguments and input payloads", () => {
  const previous = console.log;
  const calls = [];
  console.log = (...args) => calls.push(args);
  try {
    audit("tool-call", {
      tool_calls: [
        {
          function: {
            name: "run_shell",
            arguments: "{\"cmd\":\"cat ~/.ssh/id_rsa\",\"token\":\"sk-proj-1234567890abcdef1234567890abcdef\"}",
            argumentsJson: "{\"cmd\":\"cat ~/.ssh/id_ed25519\"}"
          }
        }
      ],
      tool_use: {
        name: "write_file",
        input: { path: "/tmp/secret.txt", content: "secret-value" },
        input_json: "{\"path\":\"/tmp/secret-json.txt\",\"content\":\"json-secret-value\"}"
      },
      toolUse: { inputJson: "{\"cmd\":\"printenv ANTHROPIC_API_KEY\"}" },
      delta: { partial_json: "{\"cmd\":\"cat ~/.aws/credentials\"}" }
    });
  } finally {
    console.log = previous;
  }

  assert.equal(calls.length, 1);
  const logged = calls[0][2];
  assert.match(logged.tool_calls[0].function.arguments, /^\[omitted arguments len=\d+\]$/);
  assert.match(logged.tool_calls[0].function.argumentsJson, /^\[omitted argumentsjson len=\d+\]$/);
  assert.match(logged.tool_use.input, /^\[omitted input keys=\d+\]$/);
  assert.match(logged.tool_use.input_json, /^\[omitted input_json len=\d+\]$/);
  assert.match(logged.toolUse.inputJson, /^\[omitted inputjson len=\d+\]$/);
  assert.match(logged.delta.partial_json, /^\[omitted partial_json len=\d+\]$/);
  assert.doesNotMatch(JSON.stringify(logged), /id_rsa|id_ed25519|secret-value|json-secret-value|ANTHROPIC_API_KEY|credentials|sk-proj-/);
});

test("audit: redacts sensitive headers", () => {
  const previous = console.log;
  const calls = [];
  console.log = (...args) => calls.push(args);
  try {
    audit("headers", {
      headers: {
        authorization: "Bearer sk-proj-1234567890abcdef1234567890abcdef",
        cookie: "sid=secret",
        "proxy-authorization": "Basic abc123",
        "x-auth-token": "token-1234567890abcdef",
        "x-goog-api-key": "AIzaSyA1234567890abcdefghijklmnop",
        "client-secret": "secret-value",
        password: "password-value",
        "helicone-auth": "custom-auth-value",
        "x-credential": "credential-value",
        authentication: "authentication-value"
      }
    });
  } finally {
    console.log = previous;
  }

  assert.equal(calls.length, 1);
  const logged = calls[0][2];
  assert.equal(logged.headers.authorization, "[redacted]");
  assert.equal(logged.headers.cookie, "[redacted]");
  assert.equal(logged.headers["proxy-authorization"], "[redacted]");
  assert.equal(logged.headers["x-auth-token"], "[redacted]");
  assert.equal(logged.headers["x-goog-api-key"], "[redacted]");
  assert.equal(logged.headers["client-secret"], "[redacted]");
  assert.equal(logged.headers.password, "[redacted]");
  assert.equal(logged.headers["helicone-auth"], "[redacted]");
  assert.equal(logged.headers["x-credential"], "[redacted]");
  assert.equal(logged.headers.authentication, "[redacted]");
  assert.doesNotMatch(
    JSON.stringify(logged),
    /secret-value|password-value|custom-auth-value|credential-value|authentication-value|abc123|AIzaSyA1234567890|sk-proj-/
  );
});

test("audit: omits binary payloads instead of expanding byte arrays", () => {
  const previous = console.log;
  const calls = [];
  console.log = (...args) => calls.push(args);
  try {
    audit("binary", {
      rawBody: Buffer.from("sk-proj-1234567890abcdef1234567890abcdef"),
      nested: {
        bytes: new Uint8Array(Buffer.from("Bearer secret-token-value"))
      }
    });
  } finally {
    console.log = previous;
  }

  assert.equal(calls.length, 1);
  const logged = calls[0][2];
  assert.equal(logged.rawBody, "[omitted binary Buffer len=40]");
  assert.equal(logged.nested.bytes, "[omitted binary Uint8Array len=25]");
  assert.doesNotMatch(JSON.stringify(logged), /sk-proj-|secret-token-value|0":|1":/);
});
