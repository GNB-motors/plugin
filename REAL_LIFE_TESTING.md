# FleetEdge Fuel Monitor — Real-Life Testing Guide

> **For the team:** Follow this guide top-to-bottom to do a full end-to-end test of the Chrome extension + local backend server.

---

## What This Test Does

The extension acts as a bridge between your local backend and FleetEdge:

1. **Backend → Extension**: Server sends a task saying *"fetch fuel data for vehicle WB25R9640 from Feb 14 03:45 IST to Feb 17 14:21 IST"*
2. **Extension → FleetEdge**: Extension logs in via your browser session, resolves the registration number to a VIN, and calls the FleetEdge API for fuel consumption data
3. **Extension → Backend**: Extension POSTs the results back to the server

You just need to load the extension, log into FleetEdge, and press one button.

---

## Prerequisites

- **Node.js** installed (v18+)
- **Google Chrome** installed
- Access to FleetEdge at `https://fleetedge.home.tatamotors/`
- This repo cloned/unzipped on your machine

---

## Part 1 — Start the Local Backend Server

Open a terminal in the **root `plugin/` folder** (not the `extension/` subfolder).

```bash
cd plugin          # or wherever you cloned/unzipped this repo
npm install        # install express + dependencies (only needed once)
node server.js     # start the test backend
```

You should see this banner:

```
╔══════════════════════════════════════════════════════╗
║     FleetEdge Fuel Monitor — Local Test Server       ║
╠══════════════════════════════════════════════════════╣
║  http://localhost:3000                               ║
║  Auth token: TEST_TOKEN_123                          ║
╠══════════════════════════════════════════════════════╣
║  Extension popup settings:                           ║
║    Backend URL:   http://localhost:3000/api           ║
║    Backend Token: TEST_TOKEN_123                     ║
╠══════════════════════════════════════════════════════╣
║  Debug (open in browser):                            ║
║    http://localhost:3000/debug/tasks                 ║
║    http://localhost:3000/debug/results               ║
╚══════════════════════════════════════════════════════╝
```

**Keep this terminal open.** The server logs every request in real time so you can watch what's happening.

> **Troubleshooting — "Port 3000 already in use"**: Run this in PowerShell:
> ```powershell
> Get-NetTCPConnection -LocalPort 3000 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
> ```
> Then run `node server.js` again.

---

## Part 2 — Build the Extension (if not already built)

Open a **second terminal** in the `plugin/extension/` folder:

```bash
cd plugin/extension
npm install        # install React + Vite dependencies (only needed once)
npm run build      # builds the extension into extension/dist/
```

You should see: `✓ built in ~400ms`. This creates the `extension/dist/` folder that Chrome loads.

---

## Part 3 — Load the Extension in Chrome

1. Open Chrome and go to: `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Navigate to `plugin/extension/dist/` and select that folder
5. The **FleetEdge Monitor** extension will appear in the list

> **Already loaded from before?** Just click the **↻ refresh icon** on the extension card to reload the latest build.

---

## Part 4 — Configure the Extension

1. Click the **puzzle piece icon** in the Chrome toolbar → click **FleetEdge Monitor** to open the popup
2. Scroll down to **Settings**
3. Set **Backend URL** to:
   ```
   http://localhost:3000/api
   ```
   Click **Save**
4. Set **Backend Token** to:
   ```
   TEST_TOKEN_123
   ```
   Click **Save**

You should see a green **✓ Token Configured** badge appear.

---

## Part 5 — Log Into FleetEdge

1. Open a new Chrome tab and go to: `https://fleetedge.home.tatamotors/`
2. Log in normally with your credentials

> **Note on login issues:** If your password isn't working, use a fresh login session or ask the team for updated credentials. The extension doesn't handle your login — it just captures the Bearer token that FleetEdge sets after you log in successfully.

3. Once logged in, navigate to any page (e.g., Reports or the main dashboard)
4. Come back to the extension popup — the **FleetEdge Token** section should now show a token instead of *"No token — open FleetEdge and log in"*
5. The **Vehicle Cache** will also start loading (a list of all vehicles from your fleet)

---

## Part 6 — Trigger the Test Poll

In the extension popup, click **"▶ Poll Tasks Now"**.

The extension will:
1. Call `GET http://localhost:3000/api/tasks/pending` → receive the task for **WB25R9640**
2. Look up **WB25R9640** in the vehicle cache → get its VIN
3. Convert IST times to UTC:
   - `2026-02-14 03:45 IST` → `2026-02-13 22:15 UTC`
   - `2026-02-17 14:21 IST` → `2026-02-17 08:51 UTC`
4. Call FleetEdge `analyse-fuel-consumption` API with the VIN + UTC window
5. POST the results to `POST http://localhost:3000/api/tasks/task_001/result`

Watch the **server terminal** — you'll see each step logged in real time.

---

## Part 7 — Check the Results

Open this URL in your browser:

```
http://localhost:3000/debug/results
```

You'll see a JSON response with the fuel data the extension submitted, including:
- `fuel_used` (litres)
- `distance_covered` (km)
- `avg_speed` (km/h)
- `mileage` (km/l)
- `idle_duration` (seconds)

Also check:

```
http://localhost:3000/debug/tasks
```

The task status should have changed from `"pending"` to `"completed"`.

---

## Re-Running the Test

To reset everything back to pending (so you can test again):

```bash
curl -X POST http://localhost:3000/debug/reset
```

Or in PowerShell:
```powershell
Invoke-RestMethod -Uri http://localhost:3000/debug/reset -Method Post
```

This clears all submitted results and marks the task as `pending` again.

---

## Manual Query Test (bonus)

You can also test without polling tasks — using the Manual Query tab in the popup:

1. Click **"🔍 Manual Query"** in the popup
2. Enter:
   - **Vehicle**: `WB25R9640`
   - **From**: `2026-02-14` `03:45`
   - **To**: `2026-02-17` `14:21`
3. Click **Fetch**
4. Results appear in the popup and are also sent to `http://localhost:3000/api/fuel-data/ingest`

---

## Quick Reference

| What | Where |
|------|-------|
| Start backend | `cd plugin && node server.js` |
| Build extension | `cd plugin/extension && npm run build` |
| Load in Chrome | `chrome://extensions/` → Load unpacked → `plugin/extension/dist/` |
| Backend URL setting | `http://localhost:3000/api` |
| Backend Token setting | `TEST_TOKEN_123` |
| View submitted results | http://localhost:3000/debug/results |
| View task statuses | http://localhost:3000/debug/tasks |
| Reset tasks | `POST http://localhost:3000/debug/reset` |
| Test vehicle | WB25R9640, Feb 14 03:45 → Feb 17 14:21 IST |

---

## Test Data in server.js

The task is hardcoded in `server.js` (lines ~50–60):

```js
{
  id: 'task_001',
  vehicle_number: 'WB25R9640',
  from_date: '2026-02-14',
  from_time: '03:45',
  to_date:   '2026-02-17',
  to_time:   '14:21',
}
```

Change `vehicle_number` to any registration number that exists in your FleetEdge fleet to test with different vehicles.
