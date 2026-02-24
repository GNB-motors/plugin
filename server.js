/**
 * Local test server for FleetEdge Fuel Monitor Chrome Extension.
 *
 * Implements the full backend API contract so you can test the extension
 * end-to-end before connecting a real backend.
 *
 * Start:  npm start   (from plugin/ root)
 * URL:    http://localhost:3000
 *
 *  Endpoints the extension calls:
 *    GET  /api/tasks/pending          ← extension polls this for work
 *    POST /api/tasks/:id/result       ← extension submits fuel data here
 *    POST /api/tasks/:id/error        ← extension reports task failures here
 *    POST /api/fuel-data/ingest       ← extension sends manual query results here
 *
 *  Debug endpoints (open in browser / curl):
 *    GET  /debug/tasks                ← see current task list + statuses
 *    GET  /debug/results              ← see all submitted fuel data
 *    POST /debug/reset                ← reset all tasks back to pending
 */

const express = require('express');
const cors    = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: [/^chrome-extension:\/\//, 'http://localhost:5173', '*'] }));

// ─── Auth ─────────────────────────────────────────────────────────────────────
// The extension sends this token in the Authorization header.
// Set the same value in: extension popup → Settings → Backend Token field.
const EXPECTED_TOKEN = 'TEST_TOKEN_123';

function requireAuth(req, res, next) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (token !== EXPECTED_TOKEN) {
    console.warn(`[Auth] Rejected — bad token: "${token}"`);
    return res.status(401).json({ error: 'Invalid or missing token' });
  }
  next();
}

// ─── In-memory data store ─────────────────────────────────────────────────────
// Edit vehicle_number values to match real vehicles in your FleetEdge fleet.
// The extension will resolve these registration numbers to VINs automatically.
let tasks = [
  {
    id: 'task_001',
    vehicle_number: 'WB25R9640',
    from_date: '2026-02-14',
    from_time: '03:45',
    to_date:   '2026-02-17',
    to_time:   '14:21',
    status: 'pending',
    created_at: new Date().toISOString(),
  },
];

const results  = [];
const errors   = [];
const ingested = [];

// ─── GET /api/tasks/pending ───────────────────────────────────────────────────
app.get('/api/tasks/pending', requireAuth, (req, res) => {
  const pending = tasks.filter(t => t.status === 'pending');
  console.log(`\n[Tasks] Returning ${pending.length} pending task(s)`);
  pending.forEach(t =>
    console.log(`  → ${t.id}: ${t.vehicle_number}  ${t.from_date} ${t.from_time}  →  ${t.to_date} ${t.to_time}`)
  );

  res.json({
    tasks: pending.map(t => ({
      id:             t.id,
      vehicle_number: t.vehicle_number,
      from_date:      t.from_date,
      from_time:      t.from_time,
      to_date:        t.to_date,
      to_time:        t.to_time,
    })),
  });
});

// ─── POST /api/tasks/:taskId/result ──────────────────────────────────────────
app.post('/api/tasks/:taskId/result', requireAuth, (req, res) => {
  const { taskId } = req.params;
  const { task_id, results: taskResults, submitted_at } = req.body;

  console.log(`\n[Result] ✅ Task ${taskId} — ${taskResults.length} record(s) received`);
  console.log(`  Submitted at: ${submitted_at}`);

  if (taskResults.length > 0) {
    taskResults.forEach((r, i) => {
      console.log(`  [${i + 1}] VIN: ${r.vin || 'n/a'}`);
      console.log(`       fuel_used:        ${r.fuel_used        ?? 'n/a'} L`);
      console.log(`       distance_covered: ${r.distance_covered ?? 'n/a'} km`);
      console.log(`       avg_speed:        ${r.avg_speed        ?? 'n/a'} km/h`);
      console.log(`       mileage:          ${r.mileage          ?? 'n/a'} km/l`);
      console.log(`       idle_duration:    ${r.idle_duration    ?? 'n/a'} s`);
    });
  } else {
    console.log('  (no fuel data found for this time window)');
  }

  results.push({ taskId, task_id, results: taskResults, submitted_at, received_at: new Date().toISOString() });

  const task = tasks.find(t => t.id === taskId);
  if (task) { task.status = 'completed'; task.completed_at = new Date().toISOString(); }

  res.json({ success: true });
});

// ─── POST /api/tasks/:taskId/error ───────────────────────────────────────────
app.post('/api/tasks/:taskId/error', requireAuth, (req, res) => {
  const { taskId } = req.params;
  const { error, reported_at } = req.body;

  console.log(`\n[Error] ❌ Task ${taskId} failed`);
  console.log(`  Error:       ${error}`);
  console.log(`  Reported at: ${reported_at}`);

  errors.push({ taskId, error, reported_at, received_at: new Date().toISOString() });

  const task = tasks.find(t => t.id === taskId);
  if (task) { task.status = 'failed'; task.last_error = error; task.error_at = new Date().toISOString(); }

  res.json({ success: true });
});

// ─── POST /api/fuel-data/ingest ───────────────────────────────────────────────
// Receives results from the popup Manual Query tab
app.post('/api/fuel-data/ingest', requireAuth, (req, res) => {
  const p = req.body;

  console.log(`\n[Ingest] 🔍 Manual query result`);
  console.log(`  Identifier: ${p.identifier}  (VIN: ${p.vin})`);
  console.log(`  IST range:  ${p.fromIst}  →  ${p.toIst}`);
  console.log(`  UTC range:  ${p.fromUtc}  →  ${p.toUtc}`);
  console.log(`  Results:    ${p.resultCount} record(s)`);
  if (p.results && p.results.length > 0) {
    p.results.forEach((r, i) =>
      console.log(`  [${i + 1}] VIN: ${r.vin || 'n/a'} | fuel_used: ${r.fuel_used ?? 'n/a'} L | distance: ${r.distance_covered ?? 'n/a'} km`)
    );
  }

  ingested.push({ ...p, received_at: new Date().toISOString() });
  res.json({ success: true });
});

// ─── Debug endpoints ──────────────────────────────────────────────────────────
app.get('/debug/tasks', (req, res) => res.json({ tasks }));
app.get('/debug/results', (req, res) => res.json({ results, errors, ingested }));

app.post('/debug/reset', (req, res) => {
  tasks.forEach(t => {
    t.status = 'pending';
    delete t.completed_at;
    delete t.last_error;
    delete t.error_at;
  });
  results.length = errors.length = ingested.length = 0;
  console.log('\n[Debug] All tasks reset to pending');
  res.json({ success: true, tasks });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     FleetEdge Fuel Monitor — Local Test Server       ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  http://localhost:${PORT}                                ║`);
  console.log(`║  Auth token: ${EXPECTED_TOKEN.padEnd(40)}║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Extension popup settings:                           ║');
  console.log(`║    Backend URL:   http://localhost:${PORT}/api           ║`);
  console.log(`║    Backend Token: ${EXPECTED_TOKEN.padEnd(34)}║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Debug (open in browser):                            ║');
  console.log(`║    http://localhost:${PORT}/debug/tasks                  ║`);
  console.log(`║    http://localhost:${PORT}/debug/results                ║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Edit the vehicle_number values in server.js to match');
  console.log('  real registration numbers in your FleetEdge fleet.');
  console.log('');
  console.log('  Waiting for extension activity...\n');
});