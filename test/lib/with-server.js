// Stands a real server.js up against a throwaway DATA_DIR.
//
// Extracted from test/accounts.test.js when the billing tests needed the same thing. It is the
// harness for exactly the code where unit tests of the pieces pass while the wiring leaks: password
// handling, session cookies, and now the entitlement gate, none of which can be exercised without
// the routes, the storage and the cookie jar all present at once.
//
// scrypt is intentionally slow, so these are the seconds in `npm test`. They are worth it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER_PATH = path.join(__dirname, "..", "..", "server.js");

// Passing DATA_DIR in extraEnv points the server at a directory the caller owns, and leaves it
// on disk afterwards. That is what lets a test stop one server and start another over the same
// collections, which is the only way to prove something survives a restart.
// `node --test` runs the test files concurrently and several of them stand a server up, so a random
// port in a 900-wide range collides often enough to redden a clean suite roughly one run in ten.
// Retrying on EADDRINUSE — and only on that, so a genuinely broken boot still fails immediately and
// says why — is cheaper than coordinating port assignment across processes.
const PORT_ATTEMPTS = 8;

function startServer(dataDir, extraEnv) {
  const port = 39000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, DATABASE_URL: "", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start in time.")), 15000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("running at")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const error = new Error(`Server exited early with code ${code}.${stderr ? `\n${stderr}` : ""}`);
      error.portTaken = stderr.includes("EADDRINUSE");
      reject(error);
    });
  });

  return { child, port, ready };
}

async function withServer(run, extraEnv = {}) {
  const borrowedDataDir = Boolean(extraEnv.DATA_DIR);
  const dataDir = borrowedDataDir ? extraEnv.DATA_DIR : fs.mkdtempSync(path.join(os.tmpdir(), "curb-accounts-"));

  let child = null;
  let port = 0;

  for (let attempt = 1; ; attempt += 1) {
    const started = startServer(dataDir, extraEnv);

    try {
      await started.ready;
      child = started.child;
      port = started.port;
      break;
    } catch (error) {
      started.child.kill("SIGKILL");

      if (!error.portTaken || attempt >= PORT_ATTEMPTS) {
        if (!borrowedDataDir) {
          fs.rmSync(dataDir, { recursive: true, force: true });
        }
        throw error;
      }
    }
  }

  try {
    const origin = `http://127.0.0.1:${port}`;
    await run({
      origin,
      dataDir,
      // Reaching into the collection files is how a test reaches a state the API cannot produce —
      // an expired trial, a subscription Stripe would have written. The server re-reads them on
      // every request, so an edit here takes effect on the next call with no restart.
      readCollection: (name) => JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), "utf8")),
      writeCollection: (name, items) =>
        fs.writeFileSync(path.join(dataDir, `${name}.json`), `${JSON.stringify(items, null, 2)}\n`, "utf8"),
      call: async (pathname, options = {}) => {
        const response = await fetch(`${origin}${pathname}`, {
          ...options,
          headers: {
            "Content-Type": "application/json",
            ...(options.cookie ? { Cookie: options.cookie } : {}),
            ...(options.headers || {})
          },
          body: options.json ? JSON.stringify(options.json) : options.body
        });

        const text = await response.text();
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = text;
        }

        const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
        const sessionCookie = setCookie
          .map((value) => value.split(";")[0])
          .find((value) => value.startsWith("curb_session="));

        return { status: response.status, payload, sessionCookie, raw: text };
      }
    });
  } finally {
    child.kill("SIGKILL");

    if (!borrowedDataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

module.exports = { withServer };
