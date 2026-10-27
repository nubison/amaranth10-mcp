// setup: prompts, the one verifying login, owner-only credentials, the Claude Code registration and
// the config snippets, with every side door injected; and the terminal prompter's no-echo rule
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { GroupwareError, LoginRejected } from "../src/client.js";
import { VERSION } from "../src/server.js";
import { launchedSpec, setup, terminalPrompter } from "../src/setup.js";

const PASSWORD = "a&b PW-SECRET 한";
const ADDR = "gw.example.com", BASE = "https://gw.example.com";
const tmpHome = () => mkdtempSync(join(tmpdir(), "a10-home-"));
const sink = () => {
  let text = "";
  return { stream: new Writable({ write(c, _e, cb) { text += c; cb(); } }), text: () => text };
};

// answers in order; records each question and whether it was asked hidden
// keychain is null unless a test hands in a fake: the tests never touch the real macOS Keychain
function run({ answers = [ADDR, "hong", PASSWORD, "n"], login, claude = () => ({ status: 0 }), argv = [], env = {}, home = tmpHome(),
  keychain = null, launched = () => null } = {}) {
  const asked = [], logins = [], claudeCalls = [], out = sink(), err = sink();
  const ask = async (q, { hidden = false } = {}) => {
    asked.push([q, hidden]);
    return answers[asked.length - 1] ?? "";
  };
  const done = setup({
    argv, ask, home, env, keychain, launched, out: out.stream, err: err.stream,
    login: async ({ url, id, password }) => {
      logins.push([url, id, password]);
      return login ? login() : { user: { empName: "홍길동" } };
    },
    claude: (args) => { claudeCalls.push(args); return claude(args); },
  });
  return done.then((code) => ({ code, asked, logins, claudeCalls, out: out.text(), err: err.text(), home }));
}

const PINNED = ["-y", `amaranth10-mcp@${VERSION}`];   // the default registration names this exact version
const credentials = (home) => join(home, ".config", "amaranth10-mcp", "credentials.json");
const snippet = (args, env) => JSON.stringify({ mcpServers: { amaranth10: { command: "npx", args, ...(env && { env }) } } }, null, 2);
const AIP_ENV = { AMARANTH_URL: BASE, AMARANTH_ID: "${AMARANTH_ID}", AMARANTH_PASSWORD: "${AMARANTH_PASSWORD}" };

test("setup saves credentials owner-only and prints no secret", async () => {
  const home = tmpHome();
  mkdirSync(join(home, ".config", "amaranth10-mcp"), { recursive: true, mode: 0o755 });
  const r = await run({ home });
  assert.equal(r.code, 0);
  assert.deepEqual(r.asked, [["그룹웨어 주소(예: https://gw.example.com): ", false], ["그룹웨어 아이디: ", false],
    ["비밀번호: ", true], ["Claude Code에 등록할까요? [Y/n] ", false]]);
  assert.deepEqual(r.logins, [[BASE, "hong", PASSWORD]]);
  assert.match(r.out, /^홍길동 님으로 로그인했습니다\.$/m);
  assert.equal(statSync(join(home, ".config", "amaranth10-mcp")).mode & 0o777, 0o700);
  assert.equal(statSync(credentials(home)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(credentials(home), "utf8")), { url: BASE, id: "hong", password: PASSWORD });
  assert.ok(!(r.out + r.err).includes("PW-SECRET"));
  // declined: no registration, but the two client configs are printed
  assert.deepEqual(r.claudeCalls, [["--version"]]);
  assert.ok(r.out.includes(snippet(PINNED)));
  assert.ok(r.out.includes(snippet(PINNED, AIP_ENV)));
});

test("a refused or failed login saves nothing and registers nothing", async () => {
  for (const [error, shown] of [[new LoginRejected("password", "비밀번호 불일치"), "비밀번호 불일치"],
    [new GroupwareError("/gw/gw050A02: unexpected response"), "/gw/gw050A02: unexpected response"]]) {
    const r = await run({ login: () => { throw error; } });
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(shown), r.err);
    assert.ok(!existsSync(join(r.home, ".config")));
    assert.deepEqual(r.claudeCalls, []);
    assert.equal(r.asked.length, 3);
    assert.ok(!(r.out + r.err).includes("PW-SECRET"));
  }
});

test("an empty id or password is refused before any login", async () => {
  for (const answers of [[ADDR, "", PASSWORD], [ADDR, "  ", PASSWORD], [ADDR, "hong", ""]]) {
    const r = await run({ answers });
    assert.equal(r.code, 1);
    assert.deepEqual(r.logins, []);
  }
});

test("the address is taken as an https origin, and anything else is refused before the id", async () => {
  const r = await run({ answers: [" https://gw.example.com/#/login?x=1 ", "hong", PASSWORD, "n"] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.logins, [[BASE, "hong", PASSWORD]]);
  for (const bad of ["", "http://gw.example.com", "ftp://gw.example.com", "https://u:p@gw.example.com"]) {
    const refused = await run({ answers: [bad, "hong", PASSWORD] });
    assert.equal(refused.code, 1, bad);
    assert.match(refused.err, /https:\/\//);
    assert.equal(refused.asked.length, 1);
    assert.deepEqual(refused.logins, []);
    assert.ok(!existsSync(join(refused.home, ".config")));
  }
});

test("setup registers with Claude Code, replacing an earlier amaranth10", async () => {
  const r = await run({ answers: [ADDR, "hong", PASSWORD, ""] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.claudeCalls, [["--version"], ["mcp", "remove", "amaranth10", "-s", "user"],
    ["mcp", "add", "amaranth10", "-s", "user", "--", "npx", ...PINNED]]);
  assert.match(r.out, /amaranth10/);
});

test("--spec names the package everywhere, as an npx --package spec", async () => {
  const tgz = "/abs/amaranth10-mcp-0.6.0.tgz";
  const r = await run({ argv: ["--spec", tgz], answers: [ADDR, "hong", PASSWORD, "y"] });
  const args = ["-y", "--package", tgz, "amaranth10-mcp"];
  assert.deepEqual(r.claudeCalls.at(-1), ["mcp", "add", "amaranth10", "-s", "user", "--", "npx", ...args]);
  assert.ok(r.out.includes(snippet(args)));
  assert.ok(r.out.includes(snippet(args, AIP_ENV)));
  const missing = await run({ argv: ["--spec"] });
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.asked, []);
});

test("a relative --spec that is a file becomes absolute, since clients start elsewhere", async () => {
  const tgz = join(tmpHome(), "amaranth10-mcp-0.6.0.tgz");
  writeFileSync(tgz, "");
  const r = await run({ argv: ["--spec", relative(process.cwd(), tgz)], answers: [ADDR, "hong", PASSWORD, "y"] });
  assert.deepEqual(r.claudeCalls.at(-1).slice(-4), ["-y", "--package", tgz, "amaranth10-mcp"]);
  assert.ok(r.out.includes(snippet(["-y", "--package", tgz, "amaranth10-mcp"])));
  const named = await run({ argv: ["--spec", "amaranth10-mcp@0.6.0"], answers: [ADDR, "hong", PASSWORD, "y"] });
  assert.deepEqual(named.claudeCalls.at(-1).slice(-4), ["-y", "--package", "amaranth10-mcp@0.6.0", "amaranth10-mcp"]);
});

test("the default spec stays the pinned registry name even when the cwd has an entry named amaranth10-mcp", async (t) => {
  const dir = tmpHome();
  mkdirSync(join(dir, "amaranth10-mcp"));
  const prev = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(prev));
  const r = await run({ answers: [ADDR, "hong", PASSWORD, "y"] });
  assert.deepEqual(r.claudeCalls.at(-1), ["mcp", "add", "amaranth10", "-s", "user", "--", "npx", ...PINNED]);
  assert.ok(r.out.includes(snippet(PINNED)));
});

test("without claude on PATH, setup prints the command instead of asking", async () => {
  const r = await run({ claude: () => ({ error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) }) });
  assert.equal(r.code, 0);
  assert.equal(r.asked.length, 3);
  assert.ok(r.out.includes(`claude mcp add amaranth10 -s user -- npx -y amaranth10-mcp@${VERSION}`));
});

test("a failed registration is reported with the command to run", async () => {
  const r = await run({ answers: [ADDR, "hong", PASSWORD, "y"],
    claude: (args) => (args[1] === "add" ? { status: 1, stderr: "add failed here\n" } : { status: 1 }) });
  assert.equal(r.code, 1);
  assert.match(r.err, /add failed here/);
  assert.ok(r.err.includes(`claude mcp add amaranth10 -s user -- npx -y amaranth10-mcp@${VERSION}`));
  assert.ok(existsSync(credentials(r.home)), "the credentials stay saved");
});

test("setup says when AMARANTH_URL or AMARANTH_ID and AMARANTH_PASSWORD in the environment win over the file", async () => {
  for (const env of [{ AMARANTH_ID: "x", AMARANTH_PASSWORD: "ENV-SECRET" }, { AMARANTH_URL: "https://ENV-SECRET.example.com" }]) {
    const r = await run({ env });
    assert.match(r.out, /AMARANTH_URL.*AMARANTH_ID.*AMARANTH_PASSWORD/);
    assert.ok(!r.out.includes("ENV-SECRET"));
  }
  assert.ok(!(await run()).out.includes("참고:"));
});

test("with a keychain the password goes there and the file keeps only the address and id", async () => {
  const saved = [];
  const keychain = { save: (account, password) => { saved.push([account, password]); return true; } };
  const r = await run({ keychain });
  assert.equal(r.code, 0);
  assert.deepEqual(saved, [["hong@gw.example.com", PASSWORD]]);
  assert.deepEqual(JSON.parse(readFileSync(credentials(r.home), "utf8")), { url: BASE, id: "hong" });
  assert.match(r.out, /macOS 키체인\(hong@gw\.example\.com\)/);
  assert.ok(!(r.out + r.err).includes("PW-SECRET"));
  // a keychain that refuses the item: the password goes to the owner-only file, and setup says so
  const refused = await run({ keychain: { save: () => false } });
  assert.equal(refused.code, 0);
  assert.equal(JSON.parse(readFileSync(credentials(refused.home), "utf8")).password, PASSWORD);
  assert.match(refused.out, /키체인에 저장하지 못해/);
});

test("setup registers the spec npx was launched with, unless --spec names another", async () => {
  const gh = "github:owner/amaranth10-mcp#v1.2.3";
  const r = await run({ launched: () => gh, answers: [ADDR, "hong", PASSWORD, "y"] });
  assert.deepEqual(r.claudeCalls.at(-1).slice(-4), ["-y", "--package", gh, "amaranth10-mcp"]);
  const pinned = await run({ launched: () => "amaranth10-mcp@latest", answers: [ADDR, "hong", PASSWORD, "y"] });
  assert.deepEqual(pinned.claudeCalls.at(-1).slice(-2), PINNED);
  const named = await run({ launched: () => gh, argv: ["--spec", "github:other/x#abc"], answers: [ADDR, "hong", PASSWORD, "y"] });
  assert.equal(named.claudeCalls.at(-1).at(-2), "github:other/x#abc");
});

test("launchedSpec reads npx's own package.json and nothing else", () => {
  const dir = tmpHome(), file = join(dir, "package.json");
  writeFileSync(file, JSON.stringify({ dependencies: { "amaranth10-mcp": "x" }, _npx: { packages: ["github:o/r#v1"] } }));
  assert.equal(launchedSpec(new URL(`file://${file}`)), "github:o/r#v1");
  writeFileSync(file, JSON.stringify({ name: "some-project" }));
  assert.equal(launchedSpec(new URL(`file://${file}`)), null);
  assert.equal(launchedSpec(new URL(`file://${join(dir, "missing.json")}`)), null);
});

// ---- the terminal prompter
test("piped stdin: each question reads its own line, and nothing is echoed", { timeout: 5000 }, async () => {
  const input = new PassThrough(), out = sink();
  const ask = terminalPrompter(input, out.stream);
  input.end("hong\nPW-SECRET\ny\n");   // all at once, as a pipe delivers it
  assert.deepEqual([await ask("그룹웨어 아이디: "), await ask("비밀번호: ", { hidden: true }), await ask("Q? ")],
    ["hong", "PW-SECRET", "y"]);
  ask.close();
  assert.equal(out.text(), "그룹웨어 아이디: \n비밀번호: \nQ? \n");
});

test("a terminal echoes the id but not the password", { timeout: 5000 }, async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
  const out = sink();
  const ask = terminalPrompter(input, out.stream);
  const answer = (question, keys, opts) => {
    const pending = ask(question, opts);
    input.write(keys);   // typed after the question, like a person
    return pending;
  };
  assert.equal(await answer("그룹웨어 아이디: ", "hong\r"), "hong");
  assert.equal(await answer("비밀번호: ", "PW-SECRET\r", { hidden: true }), "PW-SECRET");
  ask.close();
  assert.match(out.text(), /그룹웨어 아이디: .*hong/s);
  assert.match(out.text(), /비밀번호: /);
  assert.ok(!out.text().includes("PW-SECRET"));
});
