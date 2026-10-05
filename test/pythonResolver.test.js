"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const {
  candidatesFor,
  resolvePythonInterpreter,
} = require("../lib/pythonResolver");

test("FORECAST_PYTHON overrides all other candidates", async () => {
  const probes = [];
  const resolved = await resolvePythonInterpreter({
    env: { FORECAST_PYTHON: "/custom/python with spaces" },
    platform: "linux",
    appDir: "/project",
    probe: async (candidate) => {
      probes.push(candidate.command);
    },
  });

  assert.equal(resolved.command, "/custom/python with spaces");
  assert.equal(resolved.display, "FORECAST_PYTHON");
  assert.deepEqual(probes, ["/custom/python with spaces"]);
});

test("macOS/Linux prefers the project .venv interpreter", async () => {
  const projectPython = "/project/.venv/bin/python";
  const resolved = await resolvePythonInterpreter({
    env: {},
    platform: "darwin",
    appDir: "/project",
    probe: async (candidate) => {
      if (candidate.command !== projectPython) throw new Error("unavailable");
    },
  });

  assert.equal(resolved.command, projectPython);
  assert.equal(resolved.display, ".venv/bin/python");
});

test("Windows prefers the project .venv interpreter and preserves paths with spaces", async () => {
  const projectDir = "C:\\Project With Spaces\\Marktradar";
  const projectPython = "C:\\Project With Spaces\\Marktradar\\.venv\\Scripts\\python.exe";
  let probed;
  const resolved = await resolvePythonInterpreter({
    env: {},
    platform: "win32",
    appDir: projectDir,
    probe: async (candidate) => {
      probed = candidate;
      if (candidate.command !== projectPython) throw new Error("unavailable");
    },
  });

  assert.equal(resolved.command, projectPython);
  assert.equal(probed.argsPrefix.length, 0);
  assert.equal(resolved.display, ".venv\\Scripts\\python.exe");
});

test("resolver continues after unusable candidates and uses the documented fallback order", async () => {
  const probes = [];
  const resolved = await resolvePythonInterpreter({
    env: {},
    platform: "linux",
    appDir: "/project",
    probe: async (candidate) => {
      probes.push(candidate.command);
      if (candidate.command !== "python3") throw new Error("unavailable");
    },
  });

  assert.deepEqual(probes, [
    "/project/.venv/bin/python",
    "/project/venv/bin/python",
    "python3",
  ]);
  assert.equal(resolved.command, "python3");
});

test("Windows py launcher is an argument-array fallback", () => {
  const launcher = candidatesFor({
    env: {},
    platform: "win32",
    appDir: "C:\\Project With Spaces\\Marktradar",
  }).find((candidate) => candidate.command === "py");

  assert.deepEqual(launcher, { command: "py", argsPrefix: ["-3"], display: "py -3" });
});

test("resolver has no usable-interpreter failure that crashes the server", async () => {
  await assert.rejects(
    () => resolvePythonInterpreter({
      env: {},
      platform: "linux",
      appDir: "/project",
      probe: async () => { throw new Error("unavailable"); },
    }),
    /No usable Python interpreter was found\. Set FORECAST_PYTHON in \.env or create a local \.venv/,
  );
});

test("candidate probing uses execFile argument arrays rather than shell command concatenation", () => {
  const resolverSource = fs.readFileSync(require.resolve("../lib/pythonResolver"), "utf8");
  assert.match(resolverSource, /execFileAsync\(candidate\.command, \[\.\.\.candidate\.argsPrefix, "--version"\]/);
  assert.doesNotMatch(resolverSource, /exec\s*\(/);
});
