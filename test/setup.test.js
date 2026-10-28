// setup: prompts, the one verifying login, saved credentials, the Claude Code registration and
// the config snippets, with every side door injected; and the terminal prompter's no-echo rule
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { GroupwareError, LoginRejected } from "../src/client.js";
import { VERSION } from "../src/server.js";
import { launchedSpec, setup, terminalPrompter } from "../src/setup.js";

const PASSWORD = "a&b PW-SECRET 한";
const ADDR = "gw.example.com", BASE = "https://gw.example.com";
const YES = [ADDR, "hong", PASSWORD, "y"];
const tmpHome = () => mkdtempSync(join(tmpdir(), "a10-home-"));
const sink = () => {
  let text = "";
  return { stream: new Writable({ write(c, _e, cb) { text += c; cb(); } }), text: () => text };
};

// answers in order; records each question and whether it was asked hidden
// keychain is null unless a test hands in a fake: the tests never touch the real macOS Keychain
async function run({ answers = [ADDR, "hong", PASSWORD, "n"], login, claude = () => ({ status: 0 }), argv = [], env = {},
  keychain = null, launched = () => null } = {}) {
  const home = tmpHome(), asked = [], logins = [], claudeCalls = [], out = sink(), err = sink();
  const ask = async (q, { hidden = false } = {}) => {
    asked.push([q, hidden]);
    return answers[asked.length - 1] ?? "";
  };
  const code = await setup({
    argv, ask, home, env, keychain, launched, out: out.stream, err: err.stream,
    login: async ({ url, id, password }) => {
      logins.push([url, id, password]);
      return login ? login() : { user: { empName: "홍길동" } };
    },
    claude: (args) => { claudeCalls.push(args); return claude(args); },
  });
  return { code, asked, logins, claudeCalls, out: out.text(), err: err.text(), home };
}

const PINNED = ["-y", `amaranth10-mcp@${VERSION}`];   // the default registration names this exact version
const MANUAL = `claude mcp add amaranth10 -s user -- npx -y amaranth10-mcp@${VERSION}`;
const credentials = (home) => join(home, ".config", "amaranth10-mcp", "credentials.json");
const snippet = (args, env) => JSON.stringify({ mcpServers: { amaranth10: { command: "npx", args, ...(env && { env }) } } }, null, 2);
const AIP_ENV = { AMARANTH_URL: BASE, AMARANTH_ID: "${AMARANTH_ID}", AMARANTH_PASSWORD: "${AMARANTH_PASSWORD}" };

test("setup asks, logs in once, saves the credentials and prints no secret", async () => {
  const r = await run();
  assert.equal(r.code, 0);
  assert.deepEqual(r.asked, [["그룹웨어 주소(예: https://gw.example.com): ", false], ["그룹웨어 아이디: ", false],
    ["비밀번호: ", true], ["Claude Code에 등록할까요? [Y/n] ", false]]);
  assert.deepEqual(r.logins, [[BASE, "hong", PASSWORD]]);
  assert.match(r.out, /^홍길동 님으로 로그인했습니다\.$/m);
  assert.deepEqual(JSON.parse(readFileSync(credentials(r.home), "utf8")), { url: BASE, id: "hong", password: PASSWORD });
  assert.ok(!(r.out + r.err).includes("PW-SECRET"));
  // declined: no registration, but the two client configs are printed
  assert.deepEqual(r.claudeCalls, [["--version"]]);
  assert.ok(r.out.includes(snippet(PINNED)));
  assert.ok(r.out.includes(snippet(PINNED, AIP_ENV)));
});

test("a refused or failed login saves nothing and registers nothing", async () => {
  for (const [error, shown] of [[new LoginRejected("비밀번호 불일치"), "로그인에 실패했습니다(비밀번호 불일치)"],
    [new GroupwareError("/gw/gw050A02: unexpected response"), "로그인하지 못했습니다(/gw/gw050A02: unexpected response)"]]) {
    const r = await run({ login: () => { throw error; } });
    assert.equal(r.code, 1);
    assert.equal(r.err, `${shown}. 아무것도 저장하지 않았습니다.\n`);
    assert.ok(!existsSync(join(r.home, ".config")));
    assert.deepEqual(r.claudeCalls, []);
    assert.ok(!(r.out + r.err).includes("PW-SECRET"));
  }
});

test("a non-https address, or an empty id or password, is refused before any login", async () => {
  for (const [answers, asked, message] of [
    [["http://gw.example.com", "hong", PASSWORD], 1, /https:\/\//],
    [[ADDR, "  ", PASSWORD], 3, /아이디와 비밀번호/],
    [[ADDR, "hong", ""], 3, /아이디와 비밀번호/],
  ]) {
    const r = await run({ answers });
    assert.equal(r.code, 1);
    assert.equal(r.asked.length, asked);
    assert.match(r.err, message);
    assert.deepEqual(r.logins, []);
    assert.ok(!existsSync(join(r.home, ".config")));
  }
});

test("setup registers with Claude Code, replacing an earlier amaranth10", async () => {
  const r = await run({ answers: [ADDR, "hong", PASSWORD, ""] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.claudeCalls, [["--version"], ["mcp", "remove", "amaranth10", "-s", "user"],
    ["mcp", "add", "amaranth10", "-s", "user", "--", "npx", ...PINNED]]);
});

test("the registered package: --spec, else the one npx was launched with, else this version pinned", async (t) => {
  // in a cwd with a file named like a relative --spec, and an entry named like the package
  const prev = process.cwd();
  process.chdir(tmpHome());
  t.after(() => process.chdir(prev));
  mkdirSync("amaranth10-mcp");
  writeFileSync("amaranth10-mcp-0.6.0.tgz", "");
  const pkg = (spec) => ["-y", "--package", spec, "amaranth10-mcp"];
  const gh = "github:owner/amaranth10-mcp#v1.2.3";
  for (const [argv, launched, args] of [
    [[], null, PINNED],   // not the cwd's amaranth10-mcp
    [["--spec", "/abs/amaranth10-mcp-0.6.0.tgz"], null, pkg("/abs/amaranth10-mcp-0.6.0.tgz")],
    [["--spec", "amaranth10-mcp-0.6.0.tgz"], null, pkg(join(process.cwd(), "amaranth10-mcp-0.6.0.tgz"))],   // clients start elsewhere
    [[], gh, pkg(gh)],
    [[], "amaranth10-mcp@latest", PINNED],
    [["--spec", "github:other/x#abc"], gh, pkg("github:other/x#abc")],
  ]) {
    const r = await run({ argv, launched: () => launched, answers: YES });
    assert.deepEqual(r.claudeCalls.at(-1), ["mcp", "add", "amaranth10", "-s", "user", "--", "npx", ...args]);
    assert.ok(r.out.includes(snippet(args)) && r.out.includes(snippet(args, AIP_ENV)), argv.join(" "));
  }
  const missing = await run({ argv: ["--spec"] });
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.asked, []);
});

test("without claude on PATH, setup prints the command instead of asking", async () => {
  const r = await run({ claude: () => ({ error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) }) });
  assert.equal(r.code, 0);
  assert.equal(r.asked.length, 3);
  assert.ok(r.out.includes(MANUAL));
});

test("a failed registration is reported with the command to run", async () => {
  const r = await run({ answers: YES, claude: (args) => (args[1] === "add" ? { status: 1, stderr: "add failed here\n" } : { status: 1 }) });
  assert.equal(r.code, 1);
  assert.match(r.err, /add failed here/);
  assert.ok(r.err.includes(MANUAL));
  assert.ok(existsSync(credentials(r.home)), "the credentials stay saved");
});

test("setup says when AMARANTH_URL or AMARANTH_ID and AMARANTH_PASSWORD in the environment win over the file", async () => {
  const r = await run({ env: { AMARANTH_ID: "x", AMARANTH_PASSWORD: "ENV-SECRET" } });
  assert.match(r.out, /AMARANTH_URL.*AMARANTH_ID.*AMARANTH_PASSWORD/);
  assert.ok(!r.out.includes("ENV-SECRET"));
  assert.ok(!(await run({ env: { AMARANTH_ID: "x" } })).out.includes("참고:"));
});

test("with a keychain the password goes there and the file keeps only the address and id", async () => {
  const saved = [];
  const r = await run({ keychain: { save: (account, password) => { saved.push([account, password]); return true; } } });
  assert.equal(r.code, 0);
  assert.deepEqual(saved, [["hong@gw.example.com", PASSWORD]]);
  assert.deepEqual(JSON.parse(readFileSync(credentials(r.home), "utf8")), { url: BASE, id: "hong" });
  assert.match(r.out, /macOS 키체인\(hong@gw\.example\.com\)/);
  assert.ok(!(r.out + r.err).includes("PW-SECRET"));
  // a keychain that refuses the item: the password goes to the owner-only file, and setup says so
  const refused = await run({ keychain: { save: () => false } });
  assert.equal(JSON.parse(readFileSync(credentials(refused.home), "utf8")).password, PASSWORD);
  assert.match(refused.out, /키체인에 저장하지 못해/);
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
  assert.ok(!out.text().includes("PW-SECRET"));
});
