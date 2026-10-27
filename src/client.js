// Amaranth 10 groupware core: request signing, the password login, credentials and the
// in-memory session. Logs go to stderr (console.error), never stdout: that is MCP's.
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const LOGIN_PATH = "/gw/gw050A02";
const GROUP_PATH = "/gw/gw050B01";   // the login page's pre-login lookup: host -> the company's groupSeq
const TIMEOUT_MS = 15000;   // the Python server's httpx timeout

const NO_CREDENTIALS = "그룹웨어 주소·아이디·비밀번호가 설정되지 않았습니다. README의 설치 안내대로 터미널에서 setup을 실행해 주세요.";
const SESSION_LOST = "세션이 다시 끊겼습니다. 잠시 후 다시 요청해 주세요.";
const rejectedText = (message) => `그룹웨어 로그인에 실패했습니다(${message}). 계정이 잠기지 않도록 같은 `
  + "아이디·비밀번호로는 다시 시도하지 않습니다. 비밀번호가 바뀌었다면 setup을 다시 실행하거나 설정에서 고쳐 주세요.";

/** A groupware API returned a failure the model should see. */
export class GroupwareError extends Error {}

/** Session missing or expired; the caller should log in again. */
export class SessionError extends Error {}

/** No usable address, id or password: the server cannot work until someone fixes them. */
class CredentialsError extends GroupwareError {}

/** The groupware refused the id or the password (not a network or mapping failure). */
export class LoginRejected extends GroupwareError {
  constructor(step, message) {
    super(message || "로그인에 실패했습니다.");
    this.step = step;
  }
}

// fetch's own text can echo a header, token included: keep the type name and a fixed code only
class TransportError extends Error {
  constructor(e) {
    const code = e?.cause?.code;
    super(typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? `${e.name} (${code})` : String(e?.name));
  }
}

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const tid = () => randomBytes(16).toString("hex");
const now = () => String(Math.floor(Date.now() / 1000));

async function send(fetch, url, init) {
  try {
    // manual: httpx follows no redirect, and a redirect must not carry the token elsewhere
    const resp = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: resp.status, text: await resp.text() };
  } catch (e) {
    throw new TransportError(e);
  }
}

/** The groupware's https origin from "gw.example.com" or a pasted page URL; GroupwareError otherwise. */
export function normalizeUrl(input) {
  const text = String(input ?? "").trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    url = null;
  }
  // https only: the password and the session token go there
  if (!url || url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new GroupwareError("그룹웨어 주소는 https://로 시작하는 주소여야 합니다(예: https://gw.example.com).");
  }
  return url.origin;
}

export function sign(signKey, token, tid, ts, pathname) {
  return createHmac("sha256", signKey).update(token + tid + ts + pathname).digest("base64");
}

/** A signed POST: body as JSON, or a FormData as multipart. Returns resultData; with full, the whole reply,
 * its resultCode left to the caller (a send's "1" means sent with some recipients left out). */
export async function request(session, pathname, body, { fetch = globalThis.fetch, full = false } = {}) {
  const path = pathname.split(/[?#]/)[0];
  const id = tid(), ts = now();
  const { base, token, signKey } = session;
  const headers = {
    "user-agent": UA,
    authorization: `Bearer ${token}`,
    timestamp: ts,
    "transaction-id": id,
    "wehago-sign": sign(signKey, token, id, ts, path),
    "access-domain": base,
    ...(body instanceof FormData ? {} : { "content-type": "application/json" }),   // fetch sets the boundary
    // the klago gateway authenticates on BIZCUBE_AT/HK, built from the token (not the jar's oAuthToken)
    cookie: `oAuthToken=${token}; signKey=${signKey}; BIZCUBE_AT=${token}; BIZCUBE_HK=${signKey}; BIZCUBE_TYPE=Web`,
    origin: base,
    referer: base + "/",
  };
  let outcome = "no response";
  try {
    const resp = await send(fetch, base + pathname, { method: "POST", headers,
      body: body instanceof FormData ? body : JSON.stringify(body) });
    outcome = `HTTP ${resp.status}`;
    if (resp.status === 401 || resp.status === 403) throw new SessionError(`${path}: HTTP ${resp.status}`);
    if (!resp.text) throw new GroupwareError(`${path}: empty response (missing required field?)`);
    let data;
    try {
      data = JSON.parse(resp.text);
    } catch {
      throw new GroupwareError(`${path}: non-JSON response`);
    }
    if (!isObject(data)) throw new GroupwareError(`${path}: unexpected response`);
    outcome += ` resultCode=${data.resultCode}`;
    const errors = isObject(data.errors) ? data.errors : {};
    if (errors.code === "E002" || data.resultMsg === "SESSION_MISMATCH") throw new SessionError(`${path}: session expired`);
    if (full) return data;
    if (!["0", "200"].includes(String(data.resultCode))) {
      throw new GroupwareError(`${path}: ${data.resultMsg || errors.message || "error"}`);
    }
    return data.resultData;
  } finally {
    console.error(`${path} ${outcome}`);   // path and result code only, never token, key, cookies or body
  }
}

// Before a login every POST gets its own fresh get_token, signed without a key. The login form's
// keys and values are encoded like the web client's encodeURIComponent; raw values break passwords with &=+%#.
async function preLoginPost(fetch, base, path, contentType, body) {
  const id = tid();
  const tok = await send(fetch, `${base}/get_token/?url=${path}`, {
    headers: { "user-agent": UA, "transaction-id": id, "content-type": "application/json; charset=utf-8" },
  });
  let signature;
  try {
    const { token, cur_date: curDate } = JSON.parse(tok.text);
    if (typeof token !== "string" || typeof curDate !== "string") throw new Error();
    signature = createHash("sha256").update(token + curDate + id + path).digest("base64");
  } catch {   // an error page, or no token: never echo it
    throw new GroupwareError(`${path}: unexpected response`);
  }
  let outcome = "no response";
  try {
    const resp = await send(fetch, base + path, {
      method: "POST",
      headers: {
        "user-agent": UA,
        "content-type": contentType,
        signature,
        "transaction-id": id,
        authorization: "Bearer undefined",
        timestamp: now(),
        origin: base,
        referer: base + "/",
      },
      body,
    });
    outcome = `HTTP ${resp.status}`;
    let data;
    try {
      data = JSON.parse(resp.text);
    } catch {
      throw new GroupwareError(`${path}: unexpected response`);
    }
    if (!isObject(data)) throw new GroupwareError(`${path}: unexpected response`);
    outcome += ` resultCode=${data.resultCode}`;
    return data;
  } finally {
    console.error(`${path} ${outcome}`);   // never the form, the token or the reply body
  }
}

const loginPost = (fetch, base, entries) => preLoginPost(fetch, base, LOGIN_PATH, "application/x-www-form-urlencoded",
  entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"));

/** The company code (groupSeq) the login form wants, as the login page looks it up from its host. */
async function lookupGroupSeq(base, { fetch = globalThis.fetch } = {}) {
  const data = await preLoginPost(fetch, base, GROUP_PATH, "application/json",
    JSON.stringify({ host: new URL(base).host }));
  const groupSeq = data.resultData?.groupMap?.groupSeq;
  if (String(data.resultCode) !== "0" || typeof groupSeq !== "string" || !groupSeq) {
    throw new GroupwareError("그룹웨어 주소에서 회사 정보를 찾지 못했습니다. 주소를 확인해 주세요.");
  }
  return groupSeq;
}

function checkOk(step, data) {
  if (String(data.resultCode) !== "200") throw new LoginRejected(step, data.resultMsg);
}

// The signing token is auth_a_token and signKey is hash_key. Missing fields are null, not
// undefined, so request bodies keep the key.
function sessionFromInfo(base, info) {
  const token = info?.auth_a_token, signKey = info?.hash_key;
  if (!token || !signKey) return null;
  const uc = info.ucUserInfo || {}, erp = info.erpUserInfo || {};
  const email = String(uc.emailAdd || "");
  const at = email.indexOf("@");
  return {
    base, token, signKey,
    user: {
      compSeq: uc.compSeq ?? null, groupSeq: uc.groupSeq ?? null,
      empSeq: uc.empSeq ?? null, deptSeq: uc.deptSeq ?? null,
      empName: uc.empName || "",
      email,   // whole, as the web client sends it in a mail's authToken
      emailAddr: at < 0 ? email : email.slice(0, at),
      emailDomain: uc.emailDomain || (at < 0 ? "" : email.slice(at + 1)),
      erpEmpCd: erp.userCode ?? null, erpCoCd: erp.companyCode ?? null,
    },
  };
}

/** credentials {url, id, password} -> the session; url may be any form normalizeUrl takes. */
export async function loginWithPassword({ url, id, password }, { fetch = globalThis.fetch } = {}) {
  const base = normalizeUrl(url);
  const groupSeq = await lookupGroupSeq(base, { fetch });
  checkOk("checkLoginId", await loginPost(fetch, base, [
    ["loginId", Buffer.from(id).toString("base64")], ["groupSeq", groupSeq],
    ["loginType", "checkLoginId"], ["apiTarget", "web"], ["langCode", "kr"], ["a10Domain", base]]));
  const data = await loginPost(fetch, base, [
    ["loginId", id], ["password", password], ["groupSeq", groupSeq],
    ["scLoginYn", "N"], ["fidoPasswdLoginYn", "null"], ["langCode", "kr"],
    ["isChangeLangCodeYn", "N"], ["a10Domain", base],
    ["isPlainText", "true"], ["isMobileVerificationIgnore", "N"]]);
  checkOk("password", data);   // LoginRejected when the groupware refuses either step
  const session = sessionFromInfo(base, data.resultData?.sessionInfo);
  if (!session || !session.user.compSeq || !session.user.empSeq) {
    throw new GroupwareError("로그인 응답에 세션 정보가 없습니다.");
  }
  return session;
}

export const credentialsFile = (home = homedir()) => join(home, ".config", "amaranth10-mcp", "credentials.json");
export const rejectedFile = (home = homedir()) => join(home, ".config", "amaranth10-mcp", "rejected.json");

// owner-only: the dir 0700 however it got made, the file written 0600 as a fresh temp file ("wx", so a
// leftover's looser bits are never reused) and renamed into place; no copy stays behind when a step fails
function writePrivate(file, text) {
  const dir = dirname(file), tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// macOS Keychain through /usr/bin/security. The password goes in on stdin (`security -i`), never in
// argv where other users' `ps` sees it, and as base64, since `-w` prints a non-ASCII one back as hex.
const KEYCHAIN_SERVICE = "amaranth10-mcp";
export const keychainAccount = (url, id) => `${id}@${String(url).replace(/^https:\/\//, "")}`;
const quote = (s) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
const macKeychain = {
  load(account) {
    const r = spawnSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf8" });
    return r.status === 0 ? Buffer.from(r.stdout.trim(), "base64").toString("utf8") : null;
  },
  save(account, password) {
    const b64 = Buffer.from(password, "utf8").toString("base64");
    spawnSync("/usr/bin/security", ["-i"],
      { input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${quote(account)} -w ${b64}\n`, encoding: "utf8" });
    return this.load(account) === password;   // `security -i` exits 0 even when its command failed
  },
};
export const defaultKeychain = process.platform === "darwin" ? macKeychain : null;

/** {url, id, password}: AMARANTH_URL, and AMARANTH_ID with AMARANTH_PASSWORD, win over ~/.config/amaranth10-mcp/credentials.json
 * (whose password may be in the keychain); null if any is missing. */
export function loadCredentials({ env = process.env, home = homedir(), keychain = null } = {}) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(credentialsFile(home), "utf8")) ?? {};
  } catch {
    // missing or unreadable: setup writes it again
  }
  const fromKeychain = () => (keychain && typeof file.url === "string" && typeof file.id === "string"
    ? keychain.load(keychainAccount(file.url, file.id)) : null);
  const pair = env.AMARANTH_ID && env.AMARANTH_PASSWORD ? env : { AMARANTH_ID: file.id, AMARANTH_PASSWORD: file.password || fromKeychain() };
  const creds = { url: env.AMARANTH_URL || file.url, id: pair.AMARANTH_ID, password: pair.AMARANTH_PASSWORD };
  return Object.values(creds).every((v) => typeof v === "string" && v) ? creds : null;
}

/** The password into the keychain when there is one (else the file); the address and id into the file,
 * owner-only. Returns where the password went: "keychain" or "file". */
export function saveCredentials({ url, id, password }, { home = homedir(), keychain = null } = {}) {
  const where = keychain?.save(keychainAccount(url, id), password) ? "keychain" : "file";
  writePrivate(credentialsFile(home), JSON.stringify(where === "keychain" ? { url, id } : { url, id, password }));
  rmSync(rejectedFile(home), { force: true });   // setup checked them: even a once-refused password gets its try
  return where;
}

function toGroupwareError(e) {
  if (e instanceof GroupwareError) return e;
  if (e instanceof SessionError) return new GroupwareError(SESSION_LOST);
  if (e instanceof TransportError) return new GroupwareError(`그룹웨어에 연결하지 못했습니다(${e.message}).`);
  return new GroupwareError(`${e?.name}: ${e?.message}`);   // bad dates, odd response shapes
}

/** The in-memory session: verify or the first call logs in, one re-login per call, and a refused password
 * is never sent again, not by this process nor by the next one (a client starts one per launch). */
export class Groupware {
  #fetch; #env; #home; #keychain;
  #session = null;
  #login = null;      // the login in flight, shared by the calls that need it
  #refused = null;   // {salt, hashes: {scrypt of url + id + password: message}}, kept in rejectedFile too

  constructor({ fetch = globalThis.fetch, env = process.env, home = homedir(), keychain = defaultKeychain } = {}) {
    this.#fetch = fetch;
    this.#env = env;
    this.#home = home;
    this.#keychain = keychain;
  }

  /** fn(session, fetch) with a session; every failure comes out as a GroupwareError with Korean text. */
  async call(fn) {
    try {
      const stale = this.#session;
      if (stale) {
        try {
          return await fn(stale, this.#fetch);
        } catch (e) {
          if (!(e instanceof SessionError)) throw e;
        }
      }
      // one login per call: a session fresh from the login is not retried
      return await fn(await this.#relogin(stale), this.#fetch);
    } catch (e) {
      throw toGroupwareError(e);
    }
  }

  /** At startup: one login, so missing or refused credentials stop the server before a client shows it
   * connected. Network trouble and odd replies do not; the first call tries again. */
  async verify() {
    try {
      await this.#relogin(null);
    } catch (e) {
      if (e instanceof CredentialsError) throw e;
      console.error(`startup login skipped: ${toGroupwareError(e).message}`);
    }
  }

  #relogin(stale) {
    if (this.#session && this.#session !== stale) return this.#session;   // another call already did
    this.#login ??= this.#doLogin().finally(() => { this.#login = null; });
    return this.#login;
  }

  async #doLogin() {
    const creds = loadCredentials({ env: this.#env, home: this.#home, keychain: this.#keychain });
    if (!creds) throw new CredentialsError(NO_CREDENTIALS);
    let url;
    try {
      url = normalizeUrl(creds.url);   // one hash however the same address is written
    } catch (e) {
      throw new CredentialsError(e.message);
    }
    // never retried: a retry loop, or a client starting the server again and again, could lock the
    // account. New credentials get one try. scrypt, so the file is no quick way to guess the password.
    const book = this.#refusals();
    const hash = scryptSync(`${url}\0${creds.id}\0${creds.password}`, book.salt, 32).toString("hex");
    if (Object.hasOwn(book.hashes, hash)) throw new CredentialsError(rejectedText(book.hashes[hash]));
    try {
      this.#session = await loginWithPassword({ ...creds, url }, { fetch: this.#fetch });
      return this.#session;
    } catch (e) {
      if (!(e instanceof LoginRejected)) throw e;   // transport errors and odd replies may be retried
      book.hashes[hash] = e.message;
      try {
        writePrivate(rejectedFile(this.#home), JSON.stringify(book));
      } catch {
        // a read-only home: this process still remembers it
      }
      this.#session = null;   // so a blocked call sends nothing, not even with the stale session
      throw new CredentialsError(rejectedText(e.message));
    }
  }

  // every refusal so far: the file's, which other server processes write too, else this process's own
  #refusals() {
    try {
      const book = JSON.parse(readFileSync(rejectedFile(this.#home), "utf8"));
      if (typeof book?.salt === "string" && isObject(book.hashes)) return (this.#refused = book);
    } catch {
      // none yet, or unreadable
    }
    return (this.#refused ??= { salt: randomBytes(16).toString("hex"), hashes: {} });
  }
}
