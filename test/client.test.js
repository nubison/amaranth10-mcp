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
const SESSION_LOST = "세션이 다시 끊겼습니다. 잠시 후 다시 요청해 주세요.";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

// logs go to stderr through console.error: muted, and read back as lines
test.beforeEach((t) => t.mock.method(console, "error", () => {}));
const stderr = () => console.error.mock.calls.map((c) => c.arguments.join(" "));

test("sign matches a known hmac", () => {
  // openssl dgst -sha256 -hmac 'test-sign-key' of
  // "G1|E1|R10123456789abcdef0123456789abcdef1700000000/event/event02A01"
  assert.equal(
    sign(SIGN_KEY, TOKEN, "0123456789abcdef0123456789abcdef", "1700000000", "/event/event02A01"),
    "z9J06oRif4ZdFoeKGH4Cg0BMB1hYLI6geRoN6HIK6E8=");
});

test("request headers, cookies and a signature over the path without the query", async () => {
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
  assert.match(h["transaction-id"], /^[0-9a-f]{32}$/);
  assert.ok(Math.abs(Number(h.timestamp) - Date.now() / 1000) < 5, "epoch seconds");
  assert.deepEqual(h, {
    "user-agent": UA, authorization: `Bearer ${TOKEN}`, timestamp: h.timestamp, "transaction-id": h["transaction-id"],
    "wehago-sign": sign(SIGN_KEY, TOKEN, h["transaction-id"], h.timestamp, "/schres/rs121A01"),
    "access-domain": BASE, "content-type": "application/json",
    // the klago gateway authenticates on BIZCUBE_AT/HK, built from the token
    cookie: `oAuthToken=${TOKEN}; signKey=${SIGN_KEY}; BIZCUBE_AT=${TOKEN}; BIZCUBE_HK=${SIGN_KEY}; BIZCUBE_TYPE=Web`,
    origin: BASE, referer: BASE + "/",
  });
});

test("a FormData body goes as multipart, and full hands back the whole reply unchecked", async () => {
  const seen = [];
  const reply = { resultCode: 1, resultMsg: "x@other.com", resultData: {} };
  const fetch = async (url, init) => {
    seen.push(init);
    return json(reply);
  };
  const form = new FormData();
  form.append("subject", "보고");
  assert.deepEqual(await request(SESSION, "/mail/mail014A04", form, { fetch, full: true }), reply);
  assert.equal(seen[0].body, form);
  assert.equal(seen[0].headers["content-type"], undefined);   // fetch adds multipart with its boundary
  await assert.rejects(request(SESSION, "/mail/mail014A04", form, { fetch }), GroupwareError);   // without full, 1 is a failure
});

test("a get is a signed GET of the query whose server-sent data line is the reply", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response('data:{"resultCode":0,"resultData":{"failCnt":0,"returnValue":1}}\n\n');
  };
  assert.deepEqual(await request(SESSION, "/eap/sse/eap107A25?docIdList=7", null, { fetch, get: true }),
    { failCnt: 0, returnValue: 1 });
  const [{ url, init }] = seen;
  assert.equal(url, `${BASE}/eap/sse/eap107A25?docIdList=7`);
  assert.deepEqual([init.method, init.body, init.headers.accept, init.headers["content-type"]],
    ["GET", undefined, "text/event-stream", undefined]);
  assert.equal(init.headers["wehago-sign"],
    sign(SIGN_KEY, TOKEN, init.headers["transaction-id"], init.headers.timestamp, "/eap/sse/eap107A25"));
});

test("request maps failures to session and groupware errors", async () => {
  const p = "/mail/api/mail019A01";
  for (const [name, reply, type, message] of [
    ["empty body", () => new Response(""), GroupwareError, `${p}: empty response (missing required field?)`],
    ["401", () => json({}, 401), SessionError],
    ["E002", () => json({ resultCode: -1, errors: { code: "E002", message: "Token is not exists" } }), SessionError],
    ["SESSION_MISMATCH", () => json({ resultCode: -1, resultMsg: "SESSION_MISMATCH" }), SessionError],
    ["failure code", () => json({ resultCode: 114, resultMsg: "bad auth" }), GroupwareError, `${p}: bad auth`],
    ["errors.message", () => json({ resultCode: -1, errors: { code: "X", message: "nope" } }), GroupwareError, `${p}: nope`],
    ["non-object", () => json([1]), GroupwareError, `${p}: unexpected response`],
    ["non-JSON", () => new Response("<html>"), GroupwareError, `${p}: non-JSON response`],
  ]) {
    await assert.rejects(request(SESSION, `${p}?q=1`, {}, { fetch: async () => reply() }),
      (e) => e instanceof type && (message === undefined || e.message === message), name);
  }
  assert.equal(await request(SESSION, "/x", {}, { fetch: async () => json({ resultCode: "200", resultData: 7 }) }), 7);
});

test("request logs one line with the path and outcome only", async () => {
  const session = { base: BASE, token: "G1|E1|TOKEN-SECRET", signKey: "KEY-SECRET", user: {} };
  for (const [reply, outcome] of [
    [() => json({ resultCode: 0, resultData: { t: "BODY-SENTINEL" } }), "HTTP 200 resultCode=0"],
    [() => json({ resultCode: 601, resultMsg: "BODY-SENTINEL" }), "HTTP 200 resultCode=601"],
    [() => new Response("BODY-SENTINEL", { status: 401 }), "HTTP 401"],
    [() => { throw new TypeError("fetch failed"); }, "no response"],
  ]) {
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
  ucUserInfo: { compSeq: "1000", groupSeq: "G1", empSeq: "E1", deptSeq: "D1", empName: "홍길동", emailAdd: "hong@example.com" },
  erpUserInfo: { userCode: "12345", companyCode: "1000" },
};
const OK_REPLY = { resultCode: "200", resultData: {} };
const LOGIN_OK = { resultCode: "200", resultData: { sessionInfo: USER_INFO } };
const GROUP_OK = { resultCode: 0, resultData: { groupMap: { groupSeq: "G-SEQ" } } };
const REFUSED = { resultCode: "E", resultMsg: "비밀번호 불일치" };

// the groupware's company lookup (pre: its get_token and POST) and login endpoints, then every other API
function fakeGroupware({ group = GROUP_OK, check = OK_REPLY, pw = LOGIN_OK, token, api } = {}) {
  const pre = [], gets = [], posts = [], apis = [];
  const reply = (r) => (typeof r === "function" ? r() : json(r));
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === "/get_token/") {
      (u.searchParams.get("url") === "/gw/gw050B01" ? pre : gets).push({ url, init });
      return token ? token() : json({ token: "T", cur_date: "20261026" });
    }
    if (u.pathname === "/gw/gw050B01") {
      pre.push({ url, init });
      return reply(group);
    }
    if (u.pathname === "/gw/gw050A02") {
      posts.push({ url, init });
      return reply(init.body.includes("loginType=checkLoginId") ? check : pw);
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

const signed = (tid, path) => createHash("sha256").update("T" + "20261026" + tid + path).digest("base64");

test("login with password sends the web client's contract and maps sessionInfo to the session", async () => {
  // form values are encoded like encodeURIComponent: raw ones break passwords with &=+%#
  const { result, pre, gets, posts } = await pwLogin({}, "a&b=c+d%e#f 한");
  // first the login page's lookup: the host in, the company code out
  assert.equal(pre[0].url, BASE + "/get_token/?url=/gw/gw050B01");
  assert.equal(pre[1].url, BASE + "/gw/gw050B01");
  assert.deepEqual(JSON.parse(pre[1].init.body), { host: "gw.example.com" });
  assert.equal(pre[1].init.headers["content-type"], "application/json");
  assert.equal(pre[1].init.headers.signature, signed(pre[0].init.headers["transaction-id"], "/gw/gw050B01"));
  assert.equal(gets.length, 2);
  assert.equal(posts.length, 2);
  for (const [i, g] of gets.entries()) {
    const { url, init: { method, headers: h } } = posts[i], tid = g.init.headers["transaction-id"];
    assert.equal(g.url, BASE + "/get_token/?url=/gw/gw050A02");
    assert.match(tid, /^[0-9a-f]{32}$/);
    assert.deepEqual([url, method, h["transaction-id"], h.signature, h.authorization, h["content-type"]],
      [BASE + "/gw/gw050A02", "POST", tid, signed(tid, "/gw/gw050A02"), "Bearer undefined", "application/x-www-form-urlencoded"]);
  }
  assert.notEqual(gets[0].init.headers["transaction-id"], gets[1].init.headers["transaction-id"]);
  assert.equal(posts[0].init.body,
    "loginId=" + Buffer.from("hong").toString("base64").replaceAll("=", "%3D") + "&groupSeq=G-SEQ"
    + "&loginType=checkLoginId&apiTarget=web&langCode=kr&a10Domain=https%3A%2F%2Fgw.example.com");
  assert.equal(posts[1].init.body,
    "loginId=hong&password=a%26b%3Dc%2Bd%25e%23f%20%ED%95%9C&groupSeq=G-SEQ&scLoginYn=N"
    + "&fidoPasswdLoginYn=null&langCode=kr&isChangeLangCodeYn=N&a10Domain=https%3A%2F%2Fgw.example.com"
    + "&isPlainText=true&isMobileVerificationIgnore=N");
  assert.deepEqual(result, {
    base: BASE, token: "G1|E1|TOKEN-SECRET", signKey: "KEY-SECRET",
    user: { compSeq: "1000", groupSeq: "G1", empSeq: "E1", deptSeq: "D1",
      empName: "홍길동", email: "hong@example.com", emailAddr: "hong", emailDomain: "example.com",
      erpEmpCd: "12345", erpCoCd: "1000" },
  });
  // missing fields are null or "", never undefined, so request bodies keep the key
  const info = { ...USER_INFO, ucUserInfo: { compSeq: "1000", empSeq: "E1" }, erpUserInfo: undefined };
  assert.deepEqual((await pwLogin({ pw: { resultCode: "200", resultData: { sessionInfo: info } } })).result.user, {
    compSeq: "1000", groupSeq: null, empSeq: "E1", deptSeq: null, empName: "", email: "", emailAddr: "", emailDomain: "",
    erpEmpCd: null, erpCoCd: null });
});

test("the address is normalized to an https origin", () => {
  for (const input of ["gw.example.com", " https://gw.example.com/#/login?x=1 ", "HTTPS://GW.example.com/"]) {
    assert.equal(normalizeUrl(input), BASE, input);
  }
  for (const bad of ["", "http://gw.example.com", "https://u:p@gw.example.com", "https://"]) {
    assert.throws(() => normalizeUrl(bad), (e) => e instanceof GroupwareError && /https:\/\//.test(e.message), bad);
  }
});

test("login rejects at either step", async () => {
  for (const [opts, sent, msg] of [
    [{ check: { resultCode: 500, resultMsg: "없는 아이디" } }, 1, "없는 아이디"],
    [{ pw: { resultCode: "E" } }, 2, "로그인에 실패했습니다."],
  ]) {
    const { error, posts } = await pwLogin(opts);
    assert.ok(error instanceof LoginRejected && error instanceof GroupwareError);
    assert.equal(posts.length, sent);
    assert.equal(error.message, msg);
  }
});

test("odd login replies are groupware errors, never refusals", async () => {
  const noCompany = "그룹웨어 주소에서 회사 정보를 찾지 못했습니다. 주소를 확인해 주세요.";
  const noSession = "로그인 응답에 세션 정보가 없습니다.";
  const badGateway = () => new Response("<html>Bad Gateway</html>", { status: 502 });
  for (const [opts, message, sent] of [
    [{ group: { resultCode: 0, resultData: { groupMap: {} } } }, noCompany, 0],
    [{ group: { resultCode: -1, resultData: { groupMap: { groupSeq: "G-SEQ" } } } }, noCompany, 0],
    [{ token: () => json({ cur_date: "20261026" }) }, "/gw/gw050B01: unexpected response", 0],
    [{ group: badGateway }, "/gw/gw050B01: unexpected response", 0],
    [{ check: () => json(["x"]) }, "/gw/gw050A02: unexpected response", 1],
    [{ pw: OK_REPLY }, noSession, 2],
    [{ pw: { resultCode: "200", resultData: { sessionInfo: { ...USER_INFO, ucUserInfo: { groupSeq: "G1" } } } } }, noSession, 2],
  ]) {
    const { error, posts } = await pwLogin(opts);
    assert.ok(error instanceof GroupwareError && !(error instanceof LoginRejected), message);
    assert.equal(error.message, message);
    assert.equal(posts.length, sent);
  }
});

test("login keeps secrets out of logs and errors", async () => {
  await pwLogin();
  const { error } = await pwLogin({ pw: REFUSED });
  const text = stderr().join("\n") + error.message;
  for (const secret of SECRETS) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(stderr().slice(0, 3), ["/gw/gw050B01 HTTP 200 resultCode=0",
    "/gw/gw050A02 HTTP 200 resultCode=200", "/gw/gw050A02 HTTP 200 resultCode=200"]);
});

// --- credentials ---

const tmpHome = () => mkdtempSync(join(tmpdir(), "a10-home-"));
const NO_CREDENTIALS = "그룹웨어 주소·아이디·비밀번호가 설정되지 않았습니다. README의 설치 안내대로 터미널에서 setup을 실행해 주세요.";
const FILE = { url: "https://file.example.com", id: "file-id", password: "file-pw" };
const ENV_PAIR = { AMARANTH_ID: "env-id", AMARANTH_PASSWORD: "env-pw" };

test("credentials: env wins, else the file, else none", () => {
  const home = tmpHome();
  assert.equal(loadCredentials({ env: {}, home }), null);
  saveCredentials(FILE, { home });
  assert.deepEqual(loadCredentials({ env: {}, home }), FILE);
  assert.deepEqual(loadCredentials({ env: ENV_PAIR, home }), { url: FILE.url, id: "env-id", password: "env-pw" });
  assert.deepEqual(loadCredentials({ env: { AMARANTH_URL: "https://env.example.com" }, home }), { ...FILE, url: "https://env.example.com" });
  assert.deepEqual(loadCredentials({ env: { AMARANTH_ID: "env-id" }, home }), FILE, "a lone AMARANTH_ID is ignored");
  // an address is needed too: env id and password alone, or a file from before the address, are not enough
  assert.equal(loadCredentials({ env: ENV_PAIR, home: tmpHome() }), null);
  writeFileSync(credentialsFile(home), JSON.stringify({ id: "old", password: "old" }));
  assert.equal(loadCredentials({ env: {}, home }), null);
  writeFileSync(credentialsFile(home), "{");
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
  loadCredentials({ env: ENV_PAIR, home, keychain });
  assert.equal(reads.length, 1, "env id and password never ask the keychain");
  // a keychain that refuses: the file keeps the password, and that one is used over the keychain's
  const refused = tmpHome();
  assert.equal(saveCredentials(FILE, { home: refused, keychain: { save: () => false } }), "file");
  assert.deepEqual(loadCredentials({ env: {}, home: refused, keychain: { load: () => "OTHER" } }), FILE);
});

test("credentials are written 0600 in a 0700 dir through a fresh temp file that never stays behind", () => {
  const home = tmpHome(), dir = join(home, ".config", "amaranth10-mcp"), file = credentialsFile(home);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  writeFileSync(`${file}.${process.pid}.tmp`, "stale", { mode: 0o644 });   // a leftover with loose bits
  saveCredentials(FILE, { home });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["credentials.json"]);
  // a failed rename (the target is a directory) takes its temp copy of the password with it
  const home2 = tmpHome(), dir2 = join(home2, ".config", "amaranth10-mcp");
  mkdirSync(join(dir2, "credentials.json", "x"), { recursive: true });
  assert.throws(() => saveCredentials(FILE, { home: home2 }));
  assert.deepEqual(readdirSync(dir2), ["credentials.json"]);
});

// --- Groupware.call: re-login, mapping and anti-lockout ---

const ENV = { AMARANTH_URL: BASE, AMARANTH_ID: "hong", AMARANTH_PASSWORD: "PW-SECRET" };
const gwFor = (gw, env = ENV) => new Groupware({ fetch: gw.fetch, env, home: tmpHome(), keychain: null });
const alerts = (session, fetch) => request(session, "/event/event02A01", {}, { fetch });

test("the first call or verify logs in once; later and concurrent calls reuse the session", async () => {
  const gw = fakeGroupware();
  const g = gwFor(gw);
  assert.equal(gw.sent(), 0);   // lazy: nothing before the first call
  assert.deepEqual(await Promise.all([g.call(alerts), g.call(alerts)]), ["OK", "OK"]);
  assert.equal(await g.call(alerts), "OK");
  assert.equal(gw.posts.length, 2);   // one login is two form posts
  assert.equal(gw.apis[0].init.headers.authorization, "Bearer G1|E1|TOKEN-SECRET");
  const atStartup = fakeGroupware();
  const v = gwFor(atStartup);
  await v.verify();
  assert.equal(await v.call(alerts), "OK");
  assert.equal(atStartup.posts.length, 2);
});

test("an expired session logs in once and reruns the call; a fresh one is not retried", async () => {
  let logins = 0;
  const gw = fakeGroupware({
    pw: () => json({ resultCode: "200", resultData: { sessionInfo: { ...USER_INFO, auth_a_token: `G1|E1|T${++logins}` } } }),
    api: (u, init) => init.headers.authorization === `Bearer G1|E1|T${logins}` && logins > 1
      ? json({ resultCode: 0, resultData: "OK" }) : json({}, 401),
  });
  const g = gwFor(gw);
  // first call: a fresh login's session is refused again, so no second login
  await assert.rejects(g.call(alerts), (e) => e instanceof GroupwareError && e.message === SESSION_LOST);
  assert.equal(logins, 1);
  // second call: the stale session is refused, one re-login, the rerun works
  assert.equal(await g.call(alerts), "OK");
  assert.equal(logins, 2);
  assert.deepEqual(gw.apis.map((a) => a.init.headers.authorization),
    ["Bearer G1|E1|T1", "Bearer G1|E1|T1", "Bearer G1|E1|T2"]);
});

test("a rejected login is not retried until the credentials change, and every refusal is remembered", async () => {
  const gw = fakeGroupware({ pw: REFUSED });
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
  env.AMARANTH_PASSWORD = ENV.AMARANTH_PASSWORD;   // back to the first: still blocked
  env.AMARANTH_URL = "gw.example.com/#/login";   // the same address written another way is still blocked
  await assert.rejects(g.call(alerts), { message: rejected });
  assert.equal(gw.posts.length, 4);
  env.AMARANTH_URL = "https://other.example.com";
  await assert.rejects(g.call(alerts), { message: rejected });
  assert.equal(gw.posts.length, 6, "so does the same password at another address");
});

test("a refusal is kept on disk, so the next server process sends nothing; setup clears it", async () => {
  const gw = fakeGroupware({ pw: REFUSED });
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

test("verify stops on missing, malformed or refused credentials, not on network trouble", async () => {
  const none = fakeGroupware();
  await assert.rejects(gwFor(none, {}).verify(), { message: NO_CREDENTIALS });
  await assert.rejects(gwFor(none, {}).call(alerts), (e) => e instanceof GroupwareError && e.message === NO_CREDENTIALS);
  assert.equal(none.sent(), 0);
  await assert.rejects(gwFor(fakeGroupware(), { ...ENV, AMARANTH_URL: "http://gw.example.com" }).verify(), GroupwareError);
  await assert.rejects(gwFor(fakeGroupware({ pw: REFUSED })).verify(), /비밀번호 불일치/);
  await gwFor(fakeGroupware({ group: { resultCode: "0", resultData: {} } })).verify();   // an odd reply, not a refusal
  // network trouble: the server starts, the first call logs in again, and it is not taken for a refusal
  let down = true;
  const g = gwFor(fakeGroupware({ check: () => { if (down) throw new TypeError("fetch failed"); return json(OK_REPLY); } }));
  await g.verify();
  assert.match(stderr().join("\n"), /startup login skipped: 그룹웨어에 연결하지 못했습니다/);
  await assert.rejects(g.call(alerts), { message: "그룹웨어에 연결하지 못했습니다(TypeError)." });
  down = false;
  assert.equal(await g.call(alerts), "OK");
});

test("a rejection drops the session, so a blocked call sends nothing", async () => {
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

test("errors reach the caller as groupware errors; a transport error shows only its type, never a header", async () => {
  const g = gwFor(fakeGroupware({ api: () => json({ resultCode: 114, resultMsg: "필수 값 누락" }) }));
  await assert.rejects(g.call(alerts), (e) => e instanceof GroupwareError && e.message === "/event/event02A01: 필수 값 누락");
  await assert.rejects(g.call(() => { throw new RangeError("bad month 13"); }),
    (e) => e instanceof GroupwareError && e.message === "RangeError: bad month 13");
  const leaky = gwFor(fakeGroupware({
    api: () => { throw new TypeError("Headers.append: \"Bearer G1|E1|TOKEN-SECRET\" is an invalid header value."); },
  }));
  await assert.rejects(leaky.call(alerts), (e) => e instanceof GroupwareError && e.message === "그룹웨어에 연결하지 못했습니다(TypeError).");
  const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x KEY-SECRET"), { code: "ECONNREFUSED" }) });
  await assert.rejects(gwFor(fakeGroupware({ api: () => { throw refused; } })).call(alerts),
    { message: "그룹웨어에 연결하지 못했습니다(TypeError (ECONNREFUSED))." });
  for (const secret of SECRETS) assert.ok(!stderr().join("\n").includes(secret), secret);
});
