const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const Database = require('better-sqlite3');

// Path to the data dir as seen INSIDE the paneld container (used for fs reads).
const DATA_BASE_DIR = path.join(__dirname, '..', 'data');
// Path to the data dir on the HOST. Bind-mount sources for `docker run` are
// sent over the docker socket and resolved by the HOST daemon, so they must be
// host paths, not paneld-internal ones. Falls back to DATA_BASE_DIR when the
// daemon runs directly on the host.
const HOST_DATA_DIR = process.env.HOST_DATA_DIR || DATA_BASE_DIR;
const MC_IMAGE = process.env.MC_IMAGE || 'daemon-server';
const MC_NETWORK = process.env.MC_NETWORK || 'serverpanel';

function readServerPort(dir) {
  try {
    const txt = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    const m = txt.match(/^server-port=(\d+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function loadServers() {
  const servers = {};
  try {
    const dirs = fs.readdirSync(DATA_BASE_DIR, { withFileTypes: true });
    dirs.forEach(dirent => {
      if (dirent.isDirectory()) {
        const dataDir = path.join(DATA_BASE_DIR, dirent.name);
        servers[dirent.name] = {
          dataDir,                                        // inside paneld (fs reads)
          hostDir: path.join(HOST_DATA_DIR, dirent.name), // on host (docker -v)
          port: readServerPort(dataDir),
        };
      }
    });
  } catch (err) {
    console.error('Error loading servers:', err);
  }
  return servers;
}

const SERVERS = loadServers();

const BASE_DB_PATH = path.join(__dirname, 'servers.db');
let db = null;

// Per-server state
const processes = {};
const terminalBuffers = {};
const MAX_LINES = 10000;

function initDb() {
  if (!db) {
    db = new Database(BASE_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        pid INTEGER,
        status TEXT,
        started_at INTEGER
      )
    `);
  }
}

function getDataDir(serverId) {
  return SERVERS[serverId]?.dataDir || './data/main';
}

function savePid(serverId, pid) {
  initDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO servers (id, pid, status, started_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(serverId, pid, 'Running', Date.now());
}

function getPid(serverId) {
  initDb();
  // Check if process still running in memory first
  if (processes[serverId]) return processes[serverId].pid;
  
  // Check DB
  const row = db.prepare('SELECT pid FROM servers WHERE id = ?').get(serverId);
  if (row) {
    // Verify it's still alive
    try {
      process.kill(row.pid, 0);
      return row.pid;
    } catch {
      clearPid(serverId);
    }
  }
  return null;
}

function clearPid(serverId) {
  initDb();
  db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
}

function setStatus(serverId, status) {
  initDb();
  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run(status, serverId);
}

function pushLine(serverId = 'main', line) {
  if (!terminalBuffers[serverId]) terminalBuffers[serverId] = [];
  terminalBuffers[serverId].push(line);
  if (terminalBuffers[serverId].length > MAX_LINES) {
    terminalBuffers[serverId].shift();
  }
}

function clearLog(serverId = 'main') {
  terminalBuffers[serverId] = [];
  pushLine(serverId, "[DAEMON] Terminal cleared");
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\[?(?:\d+)?K/g, '')
    .replace(/\x1b\[H/g, '')
    .replace(/\u001b\[[0-9;]*m/g, '');
}

// Wire a child process's stdout/stderr into the terminal buffer and handle its
// exit. `removesOnExit` distinguishes `docker run --rm` (exit => container gone
// => Stopped) from `docker attach` (exit may just be a detach => re-check).
function wireProcess(serverId, proc, { removesOnExit }) {
  const onData = (chunk) => {
    chunk.toString().split('\n').forEach(line => {
      if (line.length) pushLine(serverId, stripAnsi(line));
    });
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('error', (err) => {
    pushLine(serverId, `[DAEMON] Error: ${err.message}`);
  });

  proc.on('exit', (code) => {
    processes[serverId] = null;
    if (removesOnExit) {
      pushLine(serverId, `[DAEMON] Server process exited (code ${code})`);
      setStatus(serverId, 'Stopped');
      clearPid(serverId);
      return;
    }
    // Attach client ended — the container may still be running (e.g. paneld
    // restarted and only the attach client was killed). Check before deciding.
    exec(`docker ps -q -f name=^paper-${serverId}$`, (err, out) => {
      if (out && out.trim()) {
        pushLine(serverId, "[DAEMON] Detached (container still running)");
        setStatus(serverId, 'Running');
      } else {
        pushLine(serverId, "[DAEMON] Server stopped");
        setStatus(serverId, 'Stopped');
        clearPid(serverId);
      }
    });
  });
}

// Re-attach to a single already-running paper-<id> container: backfill recent
// console history, then attach for live output + stdin.
function reattach(serverId) {
  const name = `paper-${serverId}`;
  pushLine(serverId, `[DAEMON] Reattaching to running container ${name}...`);

  // `docker attach` only streams NEW output, so backfill recent history first.
  exec(`docker logs --tail 200 ${name}`, (err, stdout, stderr) => {
    [stdout, stderr].forEach(buf => {
      if (buf) buf.split('\n').forEach(l => { if (l.length) pushLine(serverId, stripAnsi(l)); });
    });

    // --sig-proxy=false: if this attach client is killed (e.g. paneld restart),
    // do NOT forward a signal that would stop the underlying container.
    const proc = spawn('docker', ['attach', '--sig-proxy=false', name]);
    processes[serverId] = proc;
    savePid(serverId, proc.pid);
    setStatus(serverId, 'Running');
    wireProcess(serverId, proc, { removesOnExit: false });
    pushLine(serverId, "[DAEMON] Reattached (live console restored)");
  });
}

// On daemon startup, re-attach to any paper-<id> containers still running from
// before a restart so the panel regains console + stop/kill control.
function reattachAll() {
  exec(`docker ps --filter name=paper- --format '{{.Names}}'`, (err, out) => {
    if (err || !out) return;
    out.trim().split('\n').filter(Boolean).forEach(name => {
      const serverId = name.replace(/^paper-/, '');
      if (!SERVERS[serverId]) return;   // not a known data dir
      if (processes[serverId]) return;  // already attached
      reattach(serverId);
    });
  });
}

function startServer(serverId = 'main') {
  const config = SERVERS[serverId];
  if (!config) {
    pushLine(serverId, `[DAEMON] Unknown server: ${serverId}`);
    setStatus(serverId, 'Error');
    return;
  }

  if (processes[serverId]) {
    pushLine(serverId, "[DAEMON] Server already running");
    setStatus(serverId, 'Running');
    return;
  }

  clearLog(serverId);
  pushLine(serverId, "[DAEMON] Start command sent");
  setStatus(serverId, 'Starting');

  const name = `paper-${serverId}`;

  // Remove any stale container left from a previous run (ignore errors), then
  // launch the server attached so we can stream its console and write to stdin.
  exec(`docker rm -f ${name}`, () => {
    const args = ['run', '-i', '--rm', '--name', name, '--network', MC_NETWORK];
    if (config.port) args.push('-p', `${config.port}:${config.port}`);
    args.push('-v', `${config.hostDir}:/data`, MC_IMAGE);

    const proc = spawn('docker', args);
    processes[serverId] = proc;
    savePid(serverId, proc.pid);
    setStatus(serverId, 'Running');
    pushLine(serverId, `[DAEMON] Container ${name} starting (port ${config.port || 'n/a'})`);

    // `docker run --rm`: when this process exits, the container is gone.
    wireProcess(serverId, proc, { removesOnExit: true });
  });
}

function stopServer(serverId = 'main') {
  const proc = processes[serverId];
  if (!proc) {
    pushLine(serverId, "[DAEMON] No process to stop");
    return;
  }
  setStatus(serverId, 'Stopping');
  pushLine(serverId, "[DAEMON] Stop command sent");
  proc.stdin.write("stop\n");
}

function killServer(serverId = 'main') {
  pushLine(serverId, "[DAEMON] Kill command sent");
  setStatus(serverId, 'Stopping');

  // Force-remove the container; this also terminates the attached `docker run`.
  exec(`docker rm -f paper-${serverId}`, (err) => {
    if (err) pushLine(serverId, `[DAEMON] Kill error: ${err.message}`);
  });

  const proc = processes[serverId];
  if (proc) {
    try { proc.kill('SIGKILL'); } catch {}
  }
  processes[serverId] = null;
  clearPid(serverId);
}

function sendInput(serverId = 'main', text) {
  const proc = processes[serverId];
  if (!proc) {
    pushLine(serverId, "[DAEMON] Cannot send input - process not in memory (may have restarted)");
    return;
  }
  proc.stdin.write(text + "\n");
}

function getStatus(serverId = 'main') {
  initDb();
  const pid = getPid(serverId);
  if (pid) {
    try {
      process.kill(pid, 0);
      const row = db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId);
      return row?.status || 'Unknown';
    } catch {
      clearPid(serverId);
      setStatus(serverId, 'Stopped');
      return 'Stopped';
    }
  }
  return 'Stopped';
}

function getTerminalOutput(serverId = 'main') {
  return (terminalBuffers[serverId] || []).join("\n");
}


function getServers() {
  return SERVERS;
}

function serverExists(serverId) {
  const config = SERVERS[serverId];
  if(!config) return false;  // if NO config, return false
  return fs.existsSync(config.dataDir);
}

module.exports = {
  startServer,
  stopServer,
  killServer,
  sendInput,
  pushLine,
  getStatus,
  getTerminalOutput,
  clearLog,
  reattachAll,
  serverExists,
  getServers,
  getPid,
};