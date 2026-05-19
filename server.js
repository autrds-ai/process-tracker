const express = require('express');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ── Database setup ──────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'tracker.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS trackers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS steps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tracker_id  INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    assignee    TEXT    NOT NULL DEFAULT '',
    due_date    TEXT    NOT NULL DEFAULT '',
    notes       TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'todo',
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed sample data if empty
if (db.prepare('SELECT COUNT(*) as c FROM trackers').get().c === 0) {
  const addTracker = db.prepare('INSERT INTO trackers (name, description) VALUES (?, ?)');
  const addStep    = db.prepare(`
    INSERT INTO steps (tracker_id, name, description, assignee, status, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const { lastInsertRowid: t1 } = addTracker.run('Product Launch', 'End-to-end launch checklist');
  addStep.run(t1, 'Define requirements',  'Gather and document all requirements.',         'Product',     'done',       0);
  addStep.run(t1, 'Design & wireframes',  'Create UI mockups and get stakeholder sign-off.','Design',      'done',       1);
  addStep.run(t1, 'Development sprint',   'Build core features and integrations.',          'Engineering', 'inprogress', 2);
  addStep.run(t1, 'QA testing',           'End-to-end testing and bug triage.',             'QA',          'todo',       3);
  addStep.run(t1, 'Deploy to production', 'Final deployment and go-live checklist.',        'DevOps',      'todo',       4);

  const { lastInsertRowid: t2 } = addTracker.run('Onboarding Workflow', 'New employee onboarding process');
  addStep.run(t2, 'Send welcome email',    'Welcome email with first-day details.',   'HR',   'done',       0);
  addStep.run(t2, 'Provision accounts',    'Create all system accounts and access.',  'IT',   'inprogress', 1);
  addStep.run(t2, 'Schedule orientation',  '30-minute orientation session.',          'HR',   'todo',       2);
  addStep.run(t2, 'Assign buddy',          'Pair new hire with a team buddy.',        'Mgmt', 'todo',       3);
}

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── REST: Trackers ───────────────────────────────────────────────────────────
app.get('/api/trackers', (_req, res) => {
  res.json(db.prepare('SELECT * FROM trackers ORDER BY created_at ASC').all());
});

app.post('/api/trackers', (req, res) => {
  const { name, description = '' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  const { lastInsertRowid } = db.prepare('INSERT INTO trackers (name, description) VALUES (?, ?)').run(name.trim(), description.trim());
  const tracker = db.prepare('SELECT * FROM trackers WHERE id = ?').get(lastInsertRowid);
  broadcast({ type: 'tracker_created', data: tracker });
  res.json(tracker);
});

app.put('/api/trackers/:id', (req, res) => {
  const { name, description } = req.body;
  const existing = db.prepare('SELECT * FROM trackers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tracker not found' });
  db.prepare(`UPDATE trackers SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name ?? existing.name, description ?? existing.description, req.params.id);
  const tracker = db.prepare('SELECT * FROM trackers WHERE id = ?').get(req.params.id);
  broadcast({ type: 'tracker_updated', data: tracker });
  res.json(tracker);
});

app.delete('/api/trackers/:id', (req, res) => {
  db.prepare('DELETE FROM trackers WHERE id = ?').run(req.params.id);
  broadcast({ type: 'tracker_deleted', data: { id: parseInt(req.params.id) } });
  res.json({ success: true });
});

app.post('/api/trackers/:id/copy', (req, res) => {
  const source = db.prepare('SELECT * FROM trackers WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Tracker not found' });
  const steps = db.prepare('SELECT * FROM steps WHERE tracker_id = ? ORDER BY position ASC').all(req.params.id);
  const copyName = (req.body?.name?.trim()) || `${source.name} (Copy)`;
  const { lastInsertRowid: newId } = db.prepare('INSERT INTO trackers (name, description) VALUES (?, ?)').run(copyName, source.description);
  const insertStep = db.prepare(`
    INSERT INTO steps (tracker_id, name, description, assignee, due_date, notes, status, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    steps.forEach(s => insertStep.run(newId, s.name, s.description, s.assignee, s.due_date, s.notes, s.status, s.position));
  })();
  const tracker = db.prepare('SELECT * FROM trackers WHERE id = ?').get(newId);
  broadcast({ type: 'tracker_created', data: tracker });
  res.json(tracker);
});

// ── REST: Steps ──────────────────────────────────────────────────────────────
app.get('/api/trackers/:id/steps', (req, res) => {
  res.json(
    db.prepare('SELECT * FROM steps WHERE tracker_id = ? ORDER BY position ASC, id ASC').all(req.params.id)
  );
});

app.post('/api/trackers/:id/steps', (req, res) => {
  const { name, description = '', assignee = '', due_date = '', notes = '', status = 'todo' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  const { m } = db.prepare('SELECT MAX(position) as m FROM steps WHERE tracker_id = ?').get(req.params.id);
  const position = (m ?? -1) + 1;
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO steps (tracker_id, name, description, assignee, due_date, notes, status, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, name.trim(), description.trim(), assignee.trim(), due_date, notes.trim(), status, position);
  const step = db.prepare('SELECT * FROM steps WHERE id = ?').get(lastInsertRowid);
  broadcast({ type: 'step_created', data: step });
  res.json(step);
});

app.put('/api/steps/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM steps WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Step not found' });
  const f = (key) => req.body[key] !== undefined ? req.body[key] : existing[key];
  db.prepare(`
    UPDATE steps SET name=?, description=?, assignee=?, due_date=?, notes=?, status=?, position=?,
    updated_at=datetime('now') WHERE id=?
  `).run(f('name'), f('description'), f('assignee'), f('due_date'), f('notes'), f('status'), f('position'), req.params.id);
  const step = db.prepare('SELECT * FROM steps WHERE id = ?').get(req.params.id);
  broadcast({ type: 'step_updated', data: step });
  res.json(step);
});

app.delete('/api/steps/:id', (req, res) => {
  const step = db.prepare('SELECT * FROM steps WHERE id = ?').get(req.params.id);
  if (!step) return res.status(404).json({ error: 'Step not found' });
  db.prepare('DELETE FROM steps WHERE id = ?').run(req.params.id);
  broadcast({ type: 'step_deleted', data: { id: parseInt(req.params.id), tracker_id: step.tracker_id } });
  res.json({ success: true });
});

app.post('/api/trackers/:id/steps/reorder', (req, res) => {
  const { order } = req.body; // array of step ids in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
  const update = db.prepare(`UPDATE steps SET position = ?, updated_at = datetime('now') WHERE id = ?`);
  db.transaction(() => order.forEach((stepId, idx) => update.run(idx, stepId)))();
  broadcast({ type: 'steps_reordered', data: { tracker_id: parseInt(req.params.id), order } });
  res.json({ success: true });
});

// ── HTTP + WebSocket server ──────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  broadcastUserCount();
  ws.on('close', () => { clients.delete(ws); broadcastUserCount(); });
  ws.on('error', () => { clients.delete(ws); broadcastUserCount(); });
});

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === 1) c.send(str);
  }
}

function broadcastUserCount() {
  broadcast({ type: 'users_count', data: { count: clients.size } });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  Step Tracker running → http://localhost:${PORT}\n`);
});
