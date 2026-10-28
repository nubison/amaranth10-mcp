// `amaranth10-mcp setup`: ask the address, id and password, verify them with one login, save them (the
// password in the macOS Keychain when there is one), register with Claude Code if it is here, and
// print the Claude Desktop and environment-variable configs. The password is never printed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import {
  LoginRejected, credentialsFile, defaultKeychain, keychainAccount, loginWithPassword, normalizeUrl, saveCredentials,
} from "./client.js";
import { VERSION } from "./server.js";

const DEFAULT_SPEC = "amaranth10-mcp";
// npx runs a registry name directly, pinned to this version so a later release is never picked up
// unasked; a tarball or path needs --package plus the bin name
const npxArgs = (spec) => (spec === DEFAULT_SPEC ? ["-y", `${spec}@${VERSION}`] : ["-y", "--package", spec, "amaranth10-mcp"]);

// The spec npx was given (`npx -y github:owner/repo#v1 setup`), so the registration runs the same
// package. ponytail: read from npm's internal `_npx` field of the package.json two levels up; without
// it (a clone, a global install), --spec or the registry name stands.
export function launchedSpec(url = new URL("../../../package.json", import.meta.url)) {
  try {
    const spec = JSON.parse(readFileSync(url, "utf8"))._npx?.packages?.[0];
    return typeof spec === "string" && spec ? spec : null;
  } catch {
    return null;
  }
}

/** ask(question, {hidden}) on a terminal or a pipe; ask.close() lets the process end. */
export function terminalPrompter(input = process.stdin, output = process.stdout) {
  let piped;   // a pipe: one reader for every question, or the next line is lost in its buffer
  const ask = async (question, { hidden = false } = {}) => {
    if (!input.isTTY) {
      output.write(question);
      piped ??= createInterface({ input })[Symbol.asyncIterator]();
      const { value = "" } = await piped.next();
      output.write("\n");
      return value;
    }
    // a terminal: one readline per question, so it is back in its normal mode in between; a
    // hidden answer's echo goes to a stream that drops it
    let muted = false;
    const echo = new Writable({ write(chunk, _enc, cb) { if (!muted) output.write(chunk); cb(); } });
    const rl = createInterface({ input, output: echo, terminal: true });
    rl.on("SIGINT", () => { rl.close(); output.write("\n"); process.exit(130); });
    try {
      return await new Promise((resolve) => {
        rl.once("close", () => resolve(""));   // Ctrl-D
        rl.question(question, resolve);
        muted = hidden;   // the question itself is out; what is typed next is not
      });
    } finally {
      rl.close();
      if (hidden) output.write("\n");
    }
  };
  ask.close = () => piped?.return();
  return ask;
}

export async function setup({ argv = [], ask, login = loginWithPassword, home = homedir(), env = process.env,
  keychain = defaultKeychain, launched = launchedSpec,
  claude = (args) => spawnSync("claude", args, { encoding: "utf8" }),
  out = process.stdout, err = process.stderr } = {}) {
  const say = (line = "") => out.write(`${line}\n`);
  const fail = (line) => { err.write(`${line}\n`); return 1; };
  const at = argv.indexOf("--spec");
  let spec = at < 0 ? launched() ?? DEFAULT_SPEC : argv[at + 1];
  if (!spec) return fail("--spec 뒤에 패키지 이름이나 .tgz 경로를 넣어 주세요.");
  if (spec === `${DEFAULT_SPEC}@latest`) spec = DEFAULT_SPEC;   // registered pinned to this version
  else if (spec !== DEFAULT_SPEC && existsSync(spec)) spec = resolve(spec);   // clients start in another directory
  ask ??= terminalPrompter();
  try {
    let url;
    try {
      url = normalizeUrl(await ask("그룹웨어 주소(예: https://gw.example.com): "));
    } catch (e) {
      return fail(e.message);
    }
    const id = (await ask("그룹웨어 아이디: ")).trim();
    const password = await ask("비밀번호: ", { hidden: true });
    if (!id || !password) return fail("아이디와 비밀번호를 모두 넣어 주세요.");
    let session;
    try {
      session = await login({ url, id, password });
    } catch (e) {
      const why = e instanceof LoginRejected ? "로그인에 실패했습니다" : "로그인하지 못했습니다";
      return fail(`${why}(${e.message}). 아무것도 저장하지 않았습니다.`);
    }
    say(`${session.user.empName} 님으로 로그인했습니다.`);
    const where = saveCredentials({ url, id, password }, { home, keychain });
    if (where === "keychain") {
      say(`비밀번호는 macOS 키체인(${keychainAccount(url, id)})에, 주소와 아이디는 ${credentialsFile(home)}에 저장했습니다.`);
    } else {
      if (keychain) say("키체인에 저장하지 못해 비밀번호를 파일에 저장합니다.");
      say(`${credentialsFile(home)}에 저장했습니다(본인만 읽을 수 있는 0600 파일).`);
    }
    if (env.AMARANTH_URL || (env.AMARANTH_ID && env.AMARANTH_PASSWORD)) {
      say("참고: 환경변수 AMARANTH_URL, AMARANTH_ID·AMARANTH_PASSWORD가 있으면 이 파일보다 그 값을 씁니다.");
    }

    const command = ["npx", ...npxArgs(spec)];
    const manual = `claude mcp add amaranth10 -s user -- ${command.join(" ")}`;
    let code = 0;
    if (claude(["--version"]).error) {
      say(`claude 명령이 없어 Claude Code 등록은 건너뜁니다. 등록하려면: ${manual}`);
    } else if (/^[nㅜ]/i.test((await ask("Claude Code에 등록할까요? [Y/n] ")).trim())) {
      say(`Claude Code 등록은 건너뜁니다. 나중에 등록하려면: ${manual}`);
    } else {
      // setup again is how the package spec changes, so an earlier user-scope entry is replaced
      const replaced = claude(["mcp", "remove", "amaranth10", "-s", "user"]).status === 0;
      const added = claude(["mcp", "add", "amaranth10", "-s", "user", "--", ...command]);
      if (added.status === 0) {
        say(`Claude Code에 amaranth10로 ${replaced ? "다시 " : ""}등록했습니다. Claude Code를 새로 열면 쓸 수 있습니다.`);
      } else {
        const why = (added.stderr || added.stdout || added.error?.message || "").trim();
        code = fail(`Claude Code 등록에 실패했습니다: ${why}\n직접 등록하려면: ${manual}`);
      }
    }

    const server = { command: "npx", args: npxArgs(spec) };
    say();
    say("Claude Desktop (claude_desktop_config.json의 mcpServers에 추가):");
    say(JSON.stringify({ mcpServers: { amaranth10: server } }, null, 2));
    say();
    say("환경변수로 넣는 곳(서버·컨테이너 등. AMARANTH_ID·AMARANTH_PASSWORD 값은 비밀값으로 넣는다):");
    say(JSON.stringify({ mcpServers: { amaranth10: { ...server,
      env: { AMARANTH_URL: url, AMARANTH_ID: "${AMARANTH_ID}", AMARANTH_PASSWORD: "${AMARANTH_PASSWORD}" } } } }, null, 2));
    return code;
  } finally {
    ask.close?.();
  }
}
