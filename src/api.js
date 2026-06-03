require('dotenv').config();
const express = require('express');
const app = express();
const port = process.env.PORT || 3002;
const daemon = require('./daemon');

// Middleware FIRST
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Validation middleware BEFORE routes
const validateServer = (req, res, next) => {
  const id = req.params.id;
  if (!daemon.serverExists(id)) {
    return res.status(404).json({ error: 'Server not found' });
  }
  next();
};

app.use('/api/server/:id', validateServer);

/* ========== SERVERS ========== */
app.get('/api/servers/', (req, res) => {
  res.json({ servers: daemon.getServers() });
});

/* ========== SERVERS ========== */
app.get('/api/server/:id', (req, res) => {
    const id = req.params.id;
    res.json({
        id: id,
        status: daemon.getStatus(id),
        terminal: daemon.getTerminalOutput(id),
        pid: daemon.getPid(id),
    });
});


/* ========== STATUS ========== */
app.get('/api/server/:id/status', (req, res) => {
  res.json({ status: daemon.getStatus(req.params.id) });
});


/* ========== START ========== */
app.post('/api/server/:id/start', (req, res) => {
  daemon.startServer(req.params.id);
  res.json({ ok: true });
});

/* ========== STOP ========== */
app.post('/api/server/:id/stop', (req, res) => {
  daemon.stopServer(req.params.id);
  res.json({ ok: true });
});

/* ========== KILL ========== */
app.post('/api/server/:id/kill', (req, res) => {
  daemon.killServer(req.params.id);
  res.json({ ok: true });
});

/* ========== TERMINAL OUTPUT ========== */
app.get('/api/server/:id/terminal', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ output: daemon.getTerminalOutput(req.params.id) });
});

/* ========== SEND COMMAND ========== */
app.post('/api/server/:id/command', (req, res) => {
  const raw = req.body.cmd;
  if (!raw) {
    return res.status(400).json({ error: 'No command provided' });
  }

  const cmd = raw.toLowerCase().trim();
  const serverId = req.params.id;

  // Echo the command to terminal
  daemon.pushLine(serverId, `> ${raw}`);

  // Handle built-in commands
  switch (cmd) {
    case 'start':
      daemon.startServer(serverId);
      break;
    case 'stop':
      daemon.stopServer(serverId);
      break;
    case 'kill':
      daemon.killServer(serverId);
      break;
    case 'clear':
      daemon.clearLog(serverId);
      break;
    default:
      // Send to server
      daemon.sendInput(serverId, raw);
  }

  res.json({ ok: true });
});

/* ========== HEALTH CHECK ========== */
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

/* ========== START SERVER ========== */
app.listen(port, () => {
  // Re-attach to any servers still running from before a restart so the panel
  // regains live console + stop/kill control (does NOT start anything new).
  daemon.reattachAll();

  console.log(`Server running on port ${port}`);
  console.log(`Available endpoints:`);
  console.log(`  POST   /api/server/:id/start`);
  console.log(`  POST   /api/server/:id/stop`);
  console.log(`  POST   /api/server/:id/kill`);
  console.log(`  POST   /api/server/:id/command`);
  console.log(`  GET    /api/server/:id/status`);
  console.log(`  GET    /api/server/:id/terminal`);
});