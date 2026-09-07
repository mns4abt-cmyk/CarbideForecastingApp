"use strict";

const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 2500;

function candidatesFor({ env = process.env, platform = process.platform, appDir = process.cwd() } = {}) {
  const platformPath = platform === "win32" ? path.win32 : path;
  const candidates = [];
  if (typeof env.FORECAST_PYTHON === "string" && env.FORECAST_PYTHON.trim()) {
    candidates.push({ command: env.FORECAST_PYTHON.trim(), argsPrefix: [], display: "FORECAST_PYTHON" });
  }
  if (platform === "win32") {
    candidates.push(
      { command: platformPath.join(appDir, ".venv", "Scripts", "python.exe"), argsPrefix: [], display: ".venv\\Scripts\\python.exe" },
      { command: platformPath.join(appDir, "venv", "Scripts", "python.exe"), argsPrefix: [], display: "venv\\Scripts\\python.exe" },
      { command: "python.exe", argsPrefix: [], display: "python.exe" },
      { command: "python", argsPrefix: [], display: "python" },
      // The Windows launcher receives arguments as an array; no shell or
      // PowerShell is required, including when the project path has spaces.
      { command: "py", argsPrefix: ["-3"], display: "py -3" },
    );
  } else {
    candidates.push(
      { command: platformPath.join(appDir, ".venv", "bin", "python"), argsPrefix: [], display: ".venv/bin/python" },
      { command: platformPath.join(appDir, "venv", "bin", "python"), argsPrefix: [], display: "venv/bin/python" },
      { command: "python3", argsPrefix: [], display: "python3" },
      { command: "python", argsPrefix: [], display: "python" },
    );
  }
  return candidates;
}

async function probeCandidate(candidate) {
  await execFileAsync(candidate.command, [...candidate.argsPrefix, "--version"], {
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  return true;
}

function unavailablePythonError() {
  return new Error(
    "No usable Python interpreter was found. Set FORECAST_PYTHON in .env or create a local .venv " +
    "(.venv/bin/python on macOS/Linux; .venv\\Scripts\\python.exe on Windows)."
  );
}

async function resolvePythonInterpreter(options = {}) {
  const probe = options.probe || probeCandidate;
  for (const candidate of candidatesFor(options)) {
    try {
      await probe(candidate);
      return candidate;
    } catch {
      // A missing path, non-executable file, timeout, or failed launcher probe
      // is isolated to this candidate. Continue in the documented order.
    }
  }
  throw unavailablePythonError();
}

module.exports = {
  PROBE_TIMEOUT_MS,
  candidatesFor,
  probeCandidate,
  resolvePythonInterpreter,
  unavailablePythonError,
};
