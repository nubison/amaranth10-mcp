// signing and requests, the password login and its session, credentials, and Groupware.call's
// re-login, error mapping and anti-lockout
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GroupwareError, Groupware, LoginRejected, SessionError, UA, credentialsFile,
  loadCredentials, loginWithPassword, normalizeUrl, rejectedFile, request, saveCredentials, sign,
} from "../src/client.js";

const SIGN_KEY = "test-sign-key";
const TOKEN = "G1|E1|R1";
const BASE = "https://gw.example.com";
const SESSION = { base: BASE, token: TOKEN, signKey: SIGN_KEY, user: {} };
const SECRETS = ["PW-SECRET", "TOKEN-SECRET", "KEY-SECRET"];

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

// every console.error line of the test: logs go to stderr through it
function captureStderr(t) {
  t.mock.method(console, "error", () => {});
  return () => console.error.mock.calls.map((c) => c.arguments.join(" "));
}

test("sign matches a known hmac", () => {
  // openssl dgst -sha256 -hmac 'test-sign-key' of
  // "G1|E1|R10123456789abcdef0123456789abcdef1700000000/event/event02A01"
  assert.equal(
    sign(SIGN_KEY, TOKEN, "0123456789abcdef0123456789abcdef", "1700000000", "/event/event02A01"),
    "z9J06oRif4ZdFoeKGH4Cg0BMB1hYLI6geRoN6HIK6E8=");
});

test("request headers, cookies and a signature over the path without the query", async (t) => {
  captureStderr(t);
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    return json({ resultCode: 0, resultData: { ok: 1 } });
  };
  assert.deepEqual(await request(SESSION, "/schres/rs121A01?x=1", { a: 1 }, { fetch }), { ok: 1 });
  const [{ url, init }] = seen;
  const h = init.headers;
  assert.equal(url, BASE + "/schres/rs121A01?x=1");
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), { a: 1 });
  assert.equal(h["user-agent"], UA);
  assert.equal(h.authorization, `Bearer ${TOKEN}`);
  // the klago gateway authenticates on BIZCUBE_AT/HK, built from the token
  assert.equal(h.cookie,
    `oAuthToken=${TOKEN}; signKey=${SIGN_KEY}; BIZCUBE_AT=${TOKEN}; BIZCUBE_HK=${SIGN_KEY}; BIZCUBE_TYPE=Web`);
  assert.match(h["transaction-id"], /^[0-9a-f]{32}$/);
  assert.ok(Math.abs(Number(h.timestamp) - Date.now() / 1000) < 5, "epoch seconds");
  assert.equal(h["wehago-sign"],
    sign(SIGN_KEY, TOKEN, h["transaction-id"], h.timestamp, "/schres/rs121A01"));
  assert.equal(h["access-domain"], BASE);
  assert.equal(h.origin, BASE);
  assert.equal(h.referer, BASE + "/");
  assert.equal(h["content-type"], "application/json");
});

test("a FormData body goes as multipart, and full hands back the whole reply unchecked", async (t) => {
  captureStderr(t);
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(init);
    return json({ resultCode: 1, resultMsg: "x@other.com", resultData: {} });
  };
  const form = new FormData();
  form.append("subject", "보고");
  assert.deepEqual(await request(SESSION, "/mail/mail014A04", form, { fetch, full: true }),
    { resultCode: 1, resultMsg: "x@other.com", resultData: {} });
  assert.equal(seen[0].body, form);
  assert.equal(seen[0].headers["content-type"], undefined);   // fetch adds multipart with its boundary
  assert.ok(seen[0].headers["wehago-sign"]);
  await assert.rejects(request(SESSION, "/mail/mail014A04", form, { fetch }), GroupwareError);   // without full, 1 is a failure
});

test("a get is a signed GET of the query whose server-sent data line is the reply", async (t) => {
  captureStderr(t);
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response('data:{"resultCode":0,"resultData":{"failCnt":0,"returnValue":1}}\n\n');
  };
  assert.deepEqual(await request(SESSION, "/eap/sse/eap107A25?docIdList=7", null, { fetch, get: true }),
    { failCnt: 0, returnValue: 1 });
  const [{ url, init }] = seen;
  assert.equal(url, `${BASE}/eap/sse/eap107A25?docIdList=7`);
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.equal(init.headers.accept, "text/event-stream");
  assert.equal(init.headers["content-type"], undefined);
  assert.equal(init.headers["wehago-sign"],
    sign(SIGN_KEY, TOKEN, init.headers["transaction-id"], init.headers.timestamp, "/eap/sse/eap107A25"));
});

test("request maps failures like the python client", async (t) => {
  captureStderr(t);
  const cases = [
    ["empty body", () => new Response(""), GroupwareError, "/mail/api/mail019A01: empty response (missing required field?)"],
    ["401", () => json({}, 401), SessionError],
    ["403", () => json({}, 403), SessionError],
    ["E002", () => json({ resultCode: -1, errors: { code: "E002", message: "Token is not exists" } }), SessionError],
    ["SESSION_MISMATCH", () => json({ resultCode: -1, resultMsg: "SESSION_MISMATCH" }), SessionError],
    ["failure code", () => json({ resultCode: 114, resultMsg: "bad auth" }), GroupwareError, "/mail/api/mail019A01: bad auth"],
    ["errors.message", () => json({ resultCode: -1, errors: { code: "X", message: "nope" } }), GroupwareError, "/mail/api/mail019A01: nope"],
    ["non-object", () => json([1]), GroupwareError, "/mail/api/mail019A01: unexpected response"],
    ["list errors", () => json({ resultCode: -1, errors: [{ code: "X1", message: "nope" }] }), GroupwareError, "/mail/api/mail019A01: error"],
    ["non-JSON", () => new Response("<html>"), GroupwareError, "/mail/api/mail019A01: non-JSON response"],
  ];
  for (const [name, reply, type, message] of cases) {
    await assert.rejects(request(SESSION, "/mail/api/mail019A01?q=1", {}, { fetch: async () => reply() }),
      (e) => e instanceof type && (message === undefined || e.message === message), name);
  }
  assert.deepEqual(await request(SESSION, "/x", {}, { fetch: async () => json({ resultCode: "200", resultData: 7 }) }), 7);
});

test("request logs one line with the path and outcome only", async (t) => {
  const stderr = captureStderr(t);
  const session = { base: BASE, token: "G1|E1|TOKEN-SECRET", signKey: "KEY-SECRET", user: {} };
  const cases = [
    [() => json({ resultCode: 0, resultData: { t: "BODY-SENTINEL" } }), "HTTP 200 resultCode=0"],
    [() => json({ resultCode: 601, resultMsg: "BODY-SENTINEL" }), "HTTP 200 resultCode=601"],
    [() => new Response("BODY-SENTINEL", { status: 401 }), "HTTP 401"],
    [() => new Response(""), "HTTP 200"],
    [() => { throw new TypeError("fetch failed"); }, "no response"],
  ];
  for (const [reply, outcome] of cases) {
    console.error.mock.resetCalls();
    await request(session, "/event/event02A01?q=QUERY-SECRET", { x: "REQUEST-SECRET" },
      { fetch: async () => reply() }).catch(() => {});
    assert.deepEqual(stderr(), [`/event/event02A01 ${outcome}`]);
  }
});

// --- password login ---

const USER_INFO = {
  // the signing token is auth_a_token, not the cookie oAuthToken (a different, rejected value)
  auth_a_token: "G1|E1|TOKEN-SECRET",
  hash_key: "KEY-SECRET",
  ucUserInfo: {
    compSeq: "1000", groupSeq: "G1", empSeq: "E1", deptSeq: "D1", bizSeq: "B1",
    empName: "홍길동", emailAdd: "hong@example.com", emailDomain: "example.com",
  },
  erpUserInfo: { userCode: "12345", companyCode: "1000", deptCode: "D9" },
};
const OK_REPLY = { resultCode: "200", resultData: {} };
const LOGIN_OK = { resultCode: "200", resultData: { sessionInfo: USER_INFO } };

const GROUP_OK = { resultCode: 0, resultData: { groupMap: { groupSeq: "G-SEQ" } } };

// the groupware's company lookup (pre: its get_token and POST) and login endpoints, then every other API
function fakeGroupware({ group = GROUP_OK, check = OK_REPLY, pw = LOGIN_OK, token, api } = {}) {
  const pre = [], gets = [], posts = [], apis = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === "/get_token/") {
      (u.searchParams.get("url") === "/gw/gw050B01" ? pre : gets).push({ url, init });
      return token ? token() : json({ token: "T", cur_date: "20261026" });
    }
    if (u.pathname === "/gw/gw050B01") {
      pre.push({ url, init });
      return typeof group === "function" ? group() : json(group);
    }
    if (u.pathname === "/gw/gw050A02") {
      posts.push({ url, init });
      const reply = init.body.includes("loginType=checkLoginId") ? check : pw;
      return typeof reply === "function" ? reply() : json(reply);
    }
    apis.push({ url, init });
    return api ? api(u, init) : json({ resultCode: 0, resultData: "OK" });
  };
  return { fetch, pre, gets, posts, apis, sent: () => pre.length + gets.length + posts.length + apis.length };
}

async function pwLogin(opts = {}, password = "PW-SECRET") {
  const gw = fakeGroupware(opts);
  try {
    return { result: await loginWithPassword({ url: "gw.example.com", id: "hong", password }, { fetch: gw.fetch }), ...gw };
  } catch (e) {
    return { error: e, ...gw };
  }
}

test("login with password sends the web client's contract", async (t) => {
  captureStderr(t);
  const { result, pre, gets, posts } = await pwLogin();
  // first the login page's lookup: the host in, the company code out
  assert.equal(pre[0].url, BASE + "/get_token/?url=/gw/gw050B01");
  assert.equal(pre[1].url, BASE + "/gw/gw050B01");
  assert.deepEqual(JSON.parse(pre[1].init.body), { host: "gw.example.com" });
  assert.equal(pre[1].init.headers["content-type"], "application/json");
  assert.equal(pre[1].init.headers.signature, createHash("sha256")
    .update("T" + "20261026" + pre[0].init.headers["transaction-id"] + "/gw/gw050B01").digest("base64"));
  assert.equal(gets.length, 2);
  assert.equal(posts.length, 2);
  for (const [i, g] of gets.entries()) {
    const p = posts[i];
    assert.equal(g.url, BASE + "/get_token/?url=/gw/gw050A02");
    const tid = g.init.headers["transaction-id"];
    assert.match(tid, /^[0-9a-f]{32}$/);
    assert.equal(p.url, BASE + "/gw/gw050A02");
    assert.equal(p.init.method, "POST");
    assert.equal(p.init.headers["transaction-id"], tid);
    assert.equal(p.init.headers.signature,
      createHash("sha256").update("T" + "20261026" + tid + "/gw/gw050A02").digest("base64"));
    assert.equal(p.init.headers.authorization, "Bearer undefined");
    assert.equal(p.init.headers["content-type"], "application/x-www-form-urlencoded");
  }
  assert.notEqual(gets[0].init.headers["transaction-id"], gets[1].init.headers["transaction-id"]);
  assert.equal(posts[0].init.body,
    "loginId=" + Buffer.from("hong").toString("base64").replaceAll("=", "%3D") + "&groupSeq=G-SEQ"
    + "&loginType=checkLoginId&apiTarget=web&langCode=kr&a10Domain=https%3A%2F%2Fgw.example.com");
  assert.equal(posts[1].init.body,
    "loginId=hong&password=PW-SECRET&groupSeq=G-SEQ&scLoginYn=N"
    + "&fidoPasswdLoginYn=null&langCode=kr&isChangeLangCodeYn=N&a10Domain=https%3A%2F%2Fgw.example.com"
    + "&isPlainText=true&isMobileVerificationIgnore=N");
  assert.equal(result.token, "G1|E1|TOKEN-SECRET");
  assert.equal(result.signKey, "KEY-SECRET");
  assert.equal(result.base, BASE, "later requests go to the same address");
});

test("the address is normalized to an https origin", () => {
  for (const input of ["gw.example.com", " https://gw.example.com/#/login?x=1 ", "HTTPS://GW.example.com/"]) {
    assert.equal(normalizeUrl(input), BASE, input);
  }
  for (const bad of ["", undefined, "http://gw.example.com", "ftp://gw.example.com", "https://u:p@gw.example.com", "https://"]) {
    assert.throws(() => normalizeUrl(bad), (e) => e instanceof GroupwareError && /https:\/\//.test(e.message), String(bad));
  }
});

test("a lookup without a company code stops before any login request", async (t) => {
  captureStderr(t);
  for (const group of [{ resultCode: 0, resultData: { groupMap: {} } }, { resultCode: 0, resultData: null },
    { resultCode: -1, resultData: { groupMap: { groupSeq: "G-SEQ" } } }, { resultCode: 0, resultData: { groupMap: { groupSeq: 7 } } }]) {
    const { error, gets, posts } = await pwLogin({ group });
    assert.ok(error instanceof GroupwareError && !(error instanceof LoginRejected), JSON.stringify(group));
    assert.equal(error.message, "그룹웨어 주소에서 회사 정보를 찾지 못했습니다. 주소를 확인해 주세요.");
    assert.equal(gets.length + posts.length, 0);
  }
});

test("login form values are encoded like encodeURIComponent", async (t) => {
  captureStderr(t);
  const { posts } = await pwLogin({}, "a&b=c+d%e#f g/h:!~*'()한");
  assert.ok(posts[1].init.body.includes("&password=a%26b%3Dc%2Bd%25e%23f%20g%2Fh%3A!~*'()%ED%95%9C&"));
});

test("login maps sessionInfo to the session's user", async (t) => {
  captureStderr(t);
  const { result } = await pwLogin();
  assert.deepEqual(result.user, {
    compSeq: "1000", groupSeq: "G1", empSeq: "E1", deptSeq: "D1",
    empName: "홍길동", email: "hong@example.com", emailAddr: "hong", emailDomain: "example.com",
    erpEmpCd: "12345", erpCoCd: "1000",
  });
  // no guessed company code when erpUserInfo has none
  const info = { ...USER_INFO, erpUserInfo: { userCode: "12345", deptCode: "D9" } };
  const other = await pwLogin({ pw: { resultCode: "200", resultData: { sessionInfo: info } } });
  assert.equal(other.result.user.erpCoCd, null);
});

test("login rejects at either step", async (t) => {
  captureStderr(t);
  for (const [opts, step, sent, msg] of [
    [{ check: { resultCode: 500, resultMsg: "없는 아이디" } }, "checkLoginId", 1, "없는 아이디"],
    [{ pw: { resultCode: "E", resultMsg: "비밀번호 불일치" } }, "password", 2, "비밀번호 불일치"],
    [{ pw: { resultCode: "E" } }, "password", 2, "로그인에 실패했습니다."],
  ]) {
    const { error, posts } = await pwLogin(opts);
    assert.ok(error instanceof LoginRejected && error instanceof GroupwareError);
    assert.equal(error.step, step);
    assert.equal(posts.length, sent);
    assert.equal(error.message, msg);
  }
});

test("a login reply without tokens or seqs is not a rejection", async (t) => {
  captureStderr(t);
  for (const sessionInfo of [undefined, { ...USER_INFO, ucUserInfo: { groupSeq: "G1" } },
    { ...USER_INFO, auth_a_token: "" }]) {
    const { error } = await pwLogin({ pw: { resultCode: "200", resultData: { sessionInfo } } });
    assert.ok(error instanceof GroupwareError && !(error instanceof LoginRejected));
    assert.equal(error.message, "로그인 응답에 세션 정보가 없습니다.");
  }
});

test("unexpected login replies are groupware errors, not rejections", async (t) => {
  captureStderr(t);
  const badGateway = () => new Response("<html>Bad Gateway</html>", { status: 502 });
  for (const [opts, path] of [
    [{ token: () => json({ cur_date: "20261026" }) }, "/gw/gw050B01"],   // the lookup's token comes first
    [{ token: () => json(["x"]) }, "/gw/gw050B01"],
    [{ token: badGateway }, "/gw/gw050B01"],
    [{ group: badGateway }, "/gw/gw050B01"],
    [{ check: badGateway }, "/gw/gw050A02"],
    [{ check: () => json(["x"]) }, "/gw/gw050A02"],
  ]) {
    const { error } = await pwLogin(opts);
    assert.ok(error instanceof GroupwareError && !(error instanceof LoginRejected), JSON.stringify(opts));
    assert.equal(error.message, `${path}: unexpected response`);
  }
});

test("login keeps secrets out of logs and errors", async (t) => {
  const stderr = captureStderr(t);
  await pwLogin();
  const { error } = await pwLogin({ pw: { resultCode: "E", resultMsg: "비밀번호 불일치" } });
  const text = stderr().join("\n") + error.message;
  for (const secret of SECRETS) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(stderr().slice(0, 3), ["/gw/gw050B01 HTTP 200 resultCode=0",
    "/gw/gw050A02 HTTP 200 resultCode=200", "/gw/gw050A02 HTTP 200 resultCode=200"]);
});

// --- credentials ---

const tmpHome = () => mkdtempSync(join(tmpdir(), "a10-home-"));
const NO_CREDENTIALS = "그룹웨어 주소·아이디·비밀번호가 설정되지 않았습니다. README의 설치 안내대로 터미널에서 setup을 실행해 주세요.";
const FILE = { url: "https://file.example.com", id: "file-id", password: "file-pw" };

test("credentials: env wins, else the file, else none", () => {
  const home = tmpHome();
  assert.equal(loadCredentials({ env: {}, home }), null);
  saveCredentials(FILE, { home });
  assert.deepEqual(loadCredentials({ env: {}, home }), FILE);
  assert.deepEqual(loadCredentials({ env: { AMARANTH_ID: "env-id", AMARANTH_PASSWORD: "env-pw" }, home }),
    { url: FILE.url, id: "env-id", password: "env-pw" });
  assert.deepEqual(loadCredentials({ env: { AMARANTH_URL: "https://env.example.com" }, home }), { ...FILE, url: "https://env.example.com" });
  assert.deepEqual(loadCredentials({ env: { AMARANTH_ID: "env-id" }, home }), FILE, "a lone AMARANTH_ID or AMARANTH_PASSWORD is ignored");
  const all = { AMARANTH_URL: "https://env.example.com", AMARANTH_ID: "env-id", AMARANTH_PASSWORD: "env-pw" };
  assert.deepEqual(loadCredentials({ env: all, home: tmpHome() }), { url: all.AMARANTH_URL, id: "env-id", password: "env-pw" });
  // an address is needed too: env id and password alone, or a file from before the address, are not enough
  assert.equal(loadCredentials({ env: { AMARANTH_ID: "env-id", AMARANTH_PASSWORD: "env-pw" }, home: tmpHome() }), null);
  writeFileSync(join(home, ".config", "amaranth10-mcp", "credentials.json"), JSON.stringify({ id: "old", password: "old" }));
  assert.equal(loadCredentials({ env: {}, home }), null);
  writeFileSync(join(home, ".config", "amaranth10-mcp", "credentials.json"), "{");
  assert.equal(loadCredentials({ env: {}, home }), null);
});

test("credentials: a file without the password reads it from the keychain, the file's own still wins", () => {
  const home = tmpHome(), store = new Map(), reads = [];
  const keychain = {
    load: (account) => { reads.push(account); return store.get(account) ?? null; },
    save: (account, password) => { store.set(account, password); return true; },
  };
  assert.equal(saveCredentials(FILE, { home, keychain }), "keychain");
  assert.deepEqual(JSON.parse(readFileSync(credentialsFile(home), "utf8")), { url: FILE.url, id: FILE.id });
  assert.deepEqual(loadCredentials({ env: {}, home, keychain }), FILE);
  assert.deepEqual(reads, ["file-id@file.example.com"]);
  assert.equal(loadCredentials({ env: {}, home }), null, "no keychain, no password");
  // env id and password never ask the keychain
  reads.length = 0;
  loadCredentials({ env: { AMARANTH_ID: "env-id", AMARANTH_PASSWORD: "env-pw" }, home, keychain });
  assert.deepEqual(reads, []);
  // a file from before the keychain still has its password, and that one is used
  const old = tmpHome();
  saveCredentials(FILE, { home: old });
  assert.deepEqual(loadCredentials({ env: {}, home: old, keychain: { load: () => "OTHER" } }), FILE);
  // a keychain that refuses: the file keeps the password
  const refused = tmpHome();
  assert.equal(saveCredentials(FILE, { home: refused, keychain: { save: () => false } }), "file");
  assert.equal(JSON.parse(readFileSync(credentialsFile(refused), "utf8")).password, FILE.password);
});

test("credentials file is 0600 in a 0700 dir, even when the dir was 0755", () => {
  const home = tmpHome();
  const dir = join(home, ".config", "amaranth10-mcp");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  saveCredentials({ url: BASE, id: "hong", password: "a&b 한" }, { home });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const file = join(dir, "credentials.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { url: BASE, id: "hong", password: "a&b 한" });
});

test("saving credentials starts from a fresh temp file and leaves none behind", () => {
  const home = tmpHome(), dir = join(home, ".config", "amaranth10-mcp"), file = join(dir, "credentials.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.${process.pid}.tmp`, "stale", { mode: 0o644 });   // a leftover with loose bits
  saveCredentials({ id: "hong", password: "PW-SECRET" }, { home });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["credentials.json"]);
  // a failed rename (the target is a directory) takes its temp copy of the password with it
  const home2 = tmpHome(), dir2 = join(home2, ".config", "amaranth10-mcp");
  mkdirSync(join(dir2, "credentials.json", "x"), { recursive: true });
  assert.throws(() => saveCredentials({ id: "hong", password: "PW-SECRET" }, { home: home2 }));
  assert.deepEqual(readdirSync(dir2), ["credentials.json"]);
});

// --- Groupware.call: re-login, mapping and anti-lockout ---

const ENV = { AMARANTH_URL: BASE, AMARANTH_ID: "hong", AMARANTH_PASSWORD: "PW-SECRET" };
const gwFor = (gw, env = ENV) => new Groupware({ fetch: gw.fetch, env, home: tmpHome(), keychain: null });
const alerts = (session, fetch) => request(session, "/event/event02A01", {}, { fetch });

test("the first call logs in, later calls reuse the session", async (t) => {
  captureStderr(t);
  const gw = fakeGroupware();
  const g = gwFor(gw);
  assert.equal(gw.posts.length, 0);   // lazy: nothing before the first call
  assert.equal(await g.call(alerts), "OK");
  assert.equal(await g.call(alerts), "OK");
  assert.equal(gw.posts.length, 2);
  assert.equal(gw.apis.length, 2);
  assert.equal(gw.apis[0].init.headers.authorization, "Bearer G1|E1|TOKEN-SECRET");
});

test("an expired session logs in once and reruns the call", async (t) => {
  captureStderr(t);
  let logins = 0;
  const gw = fakeGroupware({
    pw: () => json({ resultCode: "200", resultData: { sessionInfo: { ...USER_INFO, auth_a_token: `G1|E1|T${++logins}` } } }),
    api: (u, init) => init.headers.authorization === `Bearer G1|E1|T${logins}` && logins > 1
      ? json({ resultCode: 0, resultData: "OK" }) : json({}, 401),
  });
  const g = gwFor(gw);
  // first call: a fresh login's session is refused again, so no second login
  await assert.rejects(g.call(alerts), { message: "세션이 다시 끊겼습니다. 잠시 후 다시 요청해 주세요." });
  assert.equal(logins, 1);
  // second call: the stale session is refused, one re-login, the rerun works
  assert.equal(await g.call(alerts), "OK");
  assert.equal(logins, 2);
  assert.deepEqual(gw.apis.map((a) => a.init.headers.authorization),
    ["Bearer G1|E1|T1", "Bearer G1|E1|T1", "Bearer G1|E1|T2"]);
});

test("a session refused again after the re-login is reported, with one login per call", async (t) => {
  captureStderr(t);
  const gw = fakeGroupware({ api: () => json({}, 401) });
  const g = gwFor(gw);
  await assert.rejects(g.call(alerts), (e) => e instanceof GroupwareError
    && e.message === "세션이 다시 끊겼습니다. 잠시 후 다시 요청해 주세요.");
  assert.equal(gw.posts.length / 2, 1);
  await assert.rejects(g.call(alerts), { message: "세션이 다시 끊겼습니다. 잠시 후 다시 요청해 주세요." });
  assert.equal(gw.posts.length / 2, 2);
});

test("a rejected login is not retried until the credentials change", async (t) => {
  captureStderr(t);
  const gw = fakeGroupware({ pw: { resultCode: "E", resultMsg: "비밀번호 불일치" } });
  const env = { ...ENV };
  const g = gwFor(gw, env);
  const rejected = "그룹웨어 로그인에 실패했습니다(비밀번호 불일치). 계정이 잠기지 않도록 같은 아이디·비밀번호로는 "
    + "다시 시도하지 않습니다. 비밀번호가 바뀌었다면 setup을 다시 실행하거나 설정에서 고쳐 주세요.";
  await assert.rejects(g.call(alerts), (e) => e instanceof GroupwareError && e.message === rejected);
  const sent = gw.sent();
  for (let i = 0; i < 3; i++) await assert.rejects(g.call(alerts), { message: rejected });
  assert.equal(gw.sent(), sent, "no request while blocked");
  env.AMARANTH_PASSWORD = "NEW-SECRET";
  await assert.rejects(g.call(alerts), { message: rejected });
  assert.equal(gw.posts.length, 4, "new credentials get one try");
  env.AMARANTH_URL = "gw.example.com/#/login";   // the same address written another way is still blocked
  await assert.rejects(g.call(alerts), { message: rejected });
  assert.equal(gw.posts.length, 4);
  env.AMARANTH_URL = "https://other.example.com";
  await assert.rejects(g.call(alerts), { message: rejected });
  assert.equal(gw.posts.length, 6, "so does the same password at another address");
});

test("every refused password is remembered, not only the last", async (t) => {
  captureStderr(t);
  const gw = fakeGroupware({ pw: { resultCode: "E", resultMsg: "비밀번호 불일치" } });
  const env = { ...ENV };
  const g = gwFor(gw, env);
  await assert.rejects(g.call(alerts), /비밀번호 불일치/);   // A, once
  env.AMARANTH_PASSWORD = "OTHER-SECRET";
  await assert.rejects(g.call(alerts), /비밀번호 불일치/);   // B, once
  env.AMARANTH_PASSWORD = ENV.AMARANTH_PASSWORD;
  await assert.rejects(g.call(alerts), /비밀번호 불일치/);   // back to A: still blocked
  assert.equal(gw.posts.length, 4, "two tries, one per password");
});

test("a refusal is kept on disk, so the next server process sends nothing; setup clears it", async (t) => {
  captureStderr(t);
  const gw = fakeGroupware({ pw: { resultCode: "E", resultMsg: "비밀번호 불일치" } });
  const home = tmpHome();
  const start = () => new Groupware({ fetch: gw.fetch, env: ENV, home, keychain: null });
  await assert.rejects(start().call(alerts), /비밀번호 불일치/);
  const sent = gw.sent();
  await assert.rejects(start().verify(), /다시 시도하지 않습니다/);   // a client's next launch
  assert.equal(gw.sent(), sent);
  const file = rejectedFile(home);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(file, "utf8"), /PW-SECRET|hong/);
  saveCredentials({ url: BASE, id: "hong", password: "PW-SECRET" }, { home });   // setup logged in with them
  await assert.rejects(start().call(alerts), /비밀번호 불일치/);
  assert.equal(gw.posts.length, 4, "one more try after setup");
});

test("verify logs in at startup and the first call reuses that session", async (t) => {
  captureStderr(t);
  const gw = fakeGroupware();
  const g = gwFor(gw);
  await g.verify();
  assert.equal(gw.posts.length, 2);
  assert.equal(await g.call(alerts), "OK");
  assert.equal(gw.posts.length, 2);
});

test("verify stops on missing, malformed or refused credentials, not on network trouble", async (t) => {
  const logs = captureStderr(t);
  await assert.rejects(gwFor(fakeGroupware(), {}).verify(), { message: NO_CREDENTIALS });
  await assert.rejects(gwFor(fakeGroupware(), { ...ENV, AMARANTH_URL: "http://gw.example.com" }).verify(), GroupwareError);
  await assert.rejects(gwFor(fakeGroupware({ pw: { resultCode: "E", resultMsg: "비밀번호 불일치" } })).verify(),
    /비밀번호 불일치/);
  const down = gwFor(fakeGroupware({ check: () => { throw new TypeError("fetch failed"); } }));
  await down.verify();   // the server starts; the first call logs in again
  assert.match(logs().join("\n"), /startup login skipped: 그룹웨어에 연결하지 못했습니다/);
  await assert.rejects(down.call(alerts), /연결하지 못했습니다/);
  await gwFor(fakeGroupware({ group: { resultCode: "0", resultData: {} } })).verify();   // an odd reply, not a refusal
});

test("a rejection drops the session, so a blocked call sends nothing", async (t) => {
  captureStderr(t);
  let reject = false, token = 0;
  const gw = fakeGroupware({
    pw: () => (reject ? json({ resultCode: "E", resultMsg: "잠김" })
      : json({ resultCode: "200", resultData: { sessionInfo: { ...USER_INFO, auth_a_token: `T${++token}` } } })),
    api: () => json({}, 401),
  });
  const g = gwFor(gw);
  await g.call(alerts).catch(() => {});   // logs in, then the fresh session is refused
  reject = true;
  await assert.rejects(g.call(alerts), /잠김/);   // stale session refused, re-login rejected
  const sent = gw.sent();
  await assert.rejects(g.call(alerts), /잠김/);
  assert.equal(gw.sent(), sent);
});

test("missing credentials fail without a request", async (t) => {
  captureStderr(t);
  const gw = fakeGroupware();
  await assert.rejects(gwFor(gw, {}).call(alerts), (e) => e instanceof GroupwareError && e.message === NO_CREDENTIALS);
  assert.equal(gw.sent(), 0);
});

test("a transport error during login is not a rejection", async (t) => {
  captureStderr(t);
  let down = true;
  const gw = fakeGroupware({ check: () => { if (down) throw new TypeError("fetch failed"); return json(OK_REPLY); } });
  const g = gwFor(gw);
  await assert.rejects(g.call(alerts), (e) => e instanceof GroupwareError && e.message === "그룹웨어에 연결하지 못했습니다(TypeError).");
  down = false;
  assert.equal(await g.call(alerts), "OK");
});

test("errors reach the caller as groupware errors with their own text", async (t) => {
  captureStderr(t);
  const gw = fakeGroupware({ api: () => json({ resultCode: 114, resultMsg: "필수 값 누락" }) });
  const g = gwFor(gw);
  await assert.rejects(g.call(alerts), (e) => e instanceof GroupwareError && e.message === "/event/event02A01: 필수 값 누락");
  await assert.rejects(g.call(() => { throw new RangeError("bad month 13"); }),
    (e) => e instanceof GroupwareError && e.message === "RangeError: bad month 13");
});

test("a transport error shows only its type name, never a header", async (t) => {
  const stderr = captureStderr(t);
  const gw = fakeGroupware({
    api: () => { throw new TypeError("Headers.append: \"Bearer G1|E1|TOKEN-SECRET\" is an invalid header value."); },
  });
  const g = gwFor(gw);
  await assert.rejects(g.call(alerts), (e) => e instanceof GroupwareError && e.message === "그룹웨어에 연결하지 못했습니다(TypeError).");
  const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x KEY-SECRET"), { code: "ECONNREFUSED" }) });
  const g2 = gwFor(fakeGroupware({ api: () => { throw refused; } }));
  await assert.rejects(g2.call(alerts), { message: "그룹웨어에 연결하지 못했습니다(TypeError (ECONNREFUSED))." });
  for (const secret of SECRETS) assert.ok(!stderr().join("\n").includes(secret), secret);
});

test("calls that start together share one login", async (t) => {
  captureStderr(t);
  const gw = fakeGroupware();
  const g = gwFor(gw);
  assert.deepEqual(await Promise.all([g.call(alerts), g.call(alerts), g.call(alerts)]), ["OK", "OK", "OK"]);
  assert.equal(gw.posts.length, 2);
});
