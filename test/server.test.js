// the MCP wiring: the content shape, errors as isError text, lax arguments, the bin over stdio,
// and the write-once rule end to end
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { Groupware } from "../src/client.js";
import { createServer } from "../src/server.js";

const BIN = fileURLToPath(new URL("../bin/amaranth10-mcp.js", import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const NO_CREDENTIALS = "그룹웨어 주소·아이디·비밀번호가 설정되지 않았습니다. README의 설치 안내대로 터미널에서 setup을 실행해 주세요.";
const tmpHome = () => mkdtempSync(join(tmpdir(), "a10-home-"));

test.beforeEach((t) => t.mock.method(console, "error", () => {}));

async function connect(gw) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createServer({ gw }).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

// ---- one fake groupware behind a real Groupware: the login endpoints, then api(path, calls)
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
const USER_INFO = { auth_a_token: "G1|E1|T", hash_key: "K",
  ucUserInfo: { compSeq: "1000", groupSeq: "G1", empSeq: "E1", deptSeq: "D1", empName: "홍길동" },
  erpUserInfo: { userCode: "12345", companyCode: "1000" } };

function fakeGroupware(api) {
  const calls = [];
  let logins = 0;
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/get_token/") return json({ token: "T", cur_date: "20261026" });
    if (path === "/gw/gw050B01") return json({ resultCode: 0, resultData: { groupMap: { groupSeq: "G-SEQ" } } });
    if (path === "/gw/gw050A02") {
      if (!init.body.includes("checkLoginId")) logins++;
      return json({ resultCode: "200", resultData: { sessionInfo: USER_INFO } });
    }
    calls.push({ path, body: JSON.parse(init.body) });
    const out = api(path, calls);
    return out instanceof Response ? out : json({ resultCode: 0, resultData: out ?? null });
  };
  const gw = new Groupware({ fetch, env: { AMARANTH_URL: "https://gw.example.com", AMARANTH_ID: "hong", AMARANTH_PASSWORD: "PW" }, home: tmpHome() });
  return { gw, calls, logins: () => logins, count: (code) => calls.filter((c) => c.path.endsWith(code)).length };
}

const texts = (r) => r.content.map((c) => [c.type, c.text]);

test("results reach the model the way Python's MCPServer renders them", async () => {
  const alert = (id) => ({ alertId: id, message: { alertTitle: "회의", alertContent: "내용" },
    createDate: "20261026100000", readDate: "" });
  const fake = fakeGroupware((path) => {
    if (path === "/event/event02A01") return { alertList: [alert(1), alert(2)] };
    if (path === "/mail/mail000A01") return { mailboxList: [] };
    return { year: "2026", totalCnt: 15, usedCnt: 3, unusedCnt: 12, progressCnt: 0 };
  });
  const client = await connect(fake.gw);
  const row = (id) => ({ id, title: "회의", content: "내용", time: "2026-10-26 10:00", unread: true });
  // a list is one text block per item, each 2-space JSON
  const listed = await client.callTool({ name: "alerts", arguments: {} });
  assert.deepEqual(texts(listed), [["text", JSON.stringify(row(1), null, 2)], ["text", JSON.stringify(row(2), null, 2)]]);
  assert.ok(!listed.isError);
  assert.equal(fake.calls[0].body.body.pageSize, "20", "the schema's default reaches the function");
  // an empty list is no block at all; a dict is one block
  assert.deepEqual((await client.callTool({ name: "mail_folders", arguments: {} })).content, []);
  const balance = await client.callTool({ name: "leave_balance", arguments: {} });
  assert.equal(balance.content.length, 1);
  assert.equal(JSON.parse(balance.content[0].text).remaining, 12);
});

test("a failure is isError with the Korean message only", async () => {
  const client = await connect(fakeGroupware(() => ({})).gw);
  const out = await client.callTool({ name: "people_search", arguments: { name: "김" } });
  assert.deepEqual([out.isError, texts(out)], [true, [["text", "이름은 2자 이상으로 검색해 주세요."]]]);
  const none = await connect(new Groupware({ env: {}, home: tmpHome() }));
  const missing = await none.callTool({ name: "alerts", arguments: {} });
  assert.deepEqual([missing.isError, texts(missing)], [true, [["text", NO_CREDENTIALS]]]);
});

test("stringified arguments are parsed like the Python SDK's pre_parse_json and lax mode", async () => {
  const KIM = { empSeq: "E7", empName: "김민수", deptSeq: "D2", deptName: "개발팀", compSeq: "1000", positionName: "주임" };
  const fake = fakeGroupware((path) => {
    if (path === "/mail/mail000A01") return { mailboxList: [{ name: "INBOX", mboxSeq: 2089 }] };
    if (path === "/mail/mail003A01") return { Records: [] };
    if (path.endsWith("sc111A02")) return { resultList: CALS };
    if (path.endsWith("gw102A04")) return [KIM];
    return {};
  });
  const client = await connect(fake.gw);
  const call = async (name, args) => {
    const out = await client.callTool({ name, arguments: args });
    assert.ok(!out.isError, JSON.stringify(out.content));
    return out;
  };
  await call("alerts", { count: "10" });
  assert.equal(fake.calls.at(-1).body.body.pageSize, "10");
  await call("mail_list", { count: "5", unread_only: "true", page: "2" });
  assert.deepEqual([fake.calls.at(-1).body.pageSize, fake.calls.at(-1).body.seen, fake.calls.at(-1).body.page], [5, "true", 2]);
  // Claude Desktop sends lists as JSON text
  const preview = await call("schedule_create",
    { title: "회의", start: "2099-01-01 15:00", end: "2099-01-01 16:00", attendees: '["김민수"]' });
  assert.deepEqual(JSON.parse(preview.content[0].text).attendees, ["김민수 (개발팀)"]);
  assert.equal(fake.count("sc111A05"), 0);
  // text that is not JSON is still refused; a str | int keeps its string
  assert.equal((await client.callTool({ name: "alerts", arguments: { count: "many" } })).isError, true);
  assert.equal((await client.callTool({ name: "approval_read", arguments: { doc_id: "123", form_id: 7 } })).isError, undefined);
  assert.deepEqual([fake.calls.at(-1).body.docID, fake.calls.at(-1).body.formID], ["123", "7"]);
});

// ---- the write-once rule through the whole stack: a 401 on the read-back must not reach the
// re-login and rerun of Groupware.call, or the write would go out twice
const CALS = [{ mcalSeq: 134, calType: "E", calRwGbn: "w", empSeq: "E1", calTitle: "내 일정", displayYn: "Y" }];
const DETAIL = { schSeq: 8439, schmSeq: 8439, mcalSeq: 134, schTitle: "주간회의",
  startDate: "209901011500", endDate: "209901011600", alldayYn: "N", repeatType: "10", calType: "E",
  resList: [], reservedList: [], addressUserList: [], schPartEmpList: [], fileList: [], fileCnt: 0 };

for (const [tool, args, write, readBack, message] of [
  ["schedule_delete", { sch_seq: 8439, confirm: true }, "sc111A06", "sc111A03",
    "일정 삭제 결과를 확인하지 못했습니다. 그룹웨어에서 확인해 주세요."],
  ["schedule_create", { title: "주간회의", start: "2099-01-01 15:00", end: "2099-01-01 16:00", confirm: true },
    "sc111A05", "sc111A04", "일정 등록 결과를 확인하지 못했습니다(sch_seq 8439). 그룹웨어에서 확인해 주세요."],
]) {
  test(`${tool}: a read-back refused for the session is unconfirmed, with one write`, async () => {
    const fake = fakeGroupware((path, calls) => {
      const wrote = calls.some((c) => c.path.endsWith(write));
      if (wrote && path.endsWith(readBack)) return json({}, 401);   // the session went stale after the write
      if (path.endsWith("sc111A02")) return { resultList: CALS };
      if (path.endsWith("sc111A04")) return DETAIL;
      if (path.endsWith("sc111A05")) return { schSeq: 8439 };
      return true;
    });
    const client = await connect(fake.gw);
    const out = await client.callTool({ name: tool, arguments: args });
    assert.deepEqual([out.isError, texts(out)], [true, [["text", message]]]);
    assert.equal(fake.count(write), 1);
    assert.equal(fake.logins(), 1);
  });
}

// ---- the bin
test("server mode writes nothing but MCP frames to stdout", async () => {
  // nothing answers at that address: the startup login is skipped and the server starts
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], stderr: "pipe",
    env: { HOME: tmpHome(), TZ: "UTC", AMARANTH_URL: "https://127.0.0.1:9", AMARANTH_ID: "hong", AMARANTH_PASSWORD: "pw" } });
  const client = new Client({ name: "test", version: "0" });
  const errors = [];
  client.onerror = (e) => errors.push(e);   // a non-JSON line on stdout lands here
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion().version, VERSION);
    assert.equal((await client.listTools()).tools.length, 27);
    const out = await client.callTool({ name: "alerts", arguments: {} });
    assert.equal(out.isError, true);
    assert.match(texts(out)[0][1], /^그룹웨어에 연결하지 못했습니다/);
  } finally {
    await client.close();
  }
  assert.deepEqual(errors, []);
});

test("server mode stops before connecting when no credentials are set", () => {
  const r = spawnSync(process.execPath, [BIN], { encoding: "utf8", input: "", env: { PATH: process.env.PATH, HOME: tmpHome() } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.ok(r.stderr.includes(NO_CREDENTIALS));
});

const run = (args, env = {}) => spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...env } });

test("the Desktop bundle's manifest names this version", () => {
  assert.equal(JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")).version, VERSION);
});

test("the bin pins Korean time before anything else runs", () => {
  // a preload reports the zone the process ends in; the child itself starts on UTC
  const probe = "data:text/javascript," + encodeURIComponent(
    "process.on('exit', () => console.error('offset', new Date(2026, 0, 1).getTimezoneOffset()))");
  const r = run(["--import", probe, BIN, "--version"], { TZ: "UTC" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${VERSION}\n`);
  assert.match(r.stderr, /^offset -540$/m);
  // the probe sees the zone at exit only; a static import would run before the TZ line
  assert.doesNotMatch(readFileSync(BIN, "utf8"), /^\s*(import|export)[\s{*"']/m);
});

test("the bin's help, and an unknown command does not start a silent server", () => {
  const help = run([BIN, "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /amaranth10-mcp setup/);
  const typo = run([BIN, "stup"]);
  assert.equal(typo.status, 2);
  assert.equal(typo.stdout, "");
  assert.match(typo.stderr, /amaranth10-mcp setup/);
});
