# FleetEdge Prototype Scraper — Python Script Plan

---

## 0. Scope (Prototype Only)
- Single Python script
- Automated browser login
- Token extraction from live network traffic
- Direct API calls using extracted token
- One report: **Fuel Consumption**
- No extension, no scaling, no persistence hardening

---

## 1. Tech Stack
- **Python 3.11+**
- **Playwright (Chromium)** – browser automation + network inspection
- **Requests** – backend API calls
- **JWT decode (optional)** – expiry awareness

---

## 2. High-Level Flow

1. Spin up headless Chromium
2. User logs into FleetEdge interactively
3. Intercept `Authorization: Bearer` token
4. Stop browser
5. Use token to call FleetEdge APIs
6. Dump JSON to stdout / file

---

## 3. Browser Automation & Auth Capture

### 3.1 Launch Browser
- Persistent context (cookies, storage)
- Non-headless first (debug-friendly)

```python
playwright.chromium.launch(
    headless=False,
    args=["--disable-blink-features=AutomationControlled"]
)
```

⸻

3.2 Navigate to Login

`https://fleetedge.home.tatamotors/`

User manually:
	•	Enters credentials
	•	Completes OTP / MFA (if any)

⸻

3.3 Network Interception Logic

Listen for requests matching:
	•	Domain: cvp.api.tatamotors
	•	Header contains: Authorization: Bearer

Extract:
	•	access_token
	•	Decode JWT → get exp, fleet_id

if "authorization" in request.headers:
    token = request.headers["authorization"].split("Bearer ")[1]


⸻

3.4 Stop Browser
	•	Close context after token capture
	•	Prototype assumes token validity for session duration

⸻

4. API Consumption Phase (Requests)

Shared Headers

```
headers = {
  "Authorization": f"Bearer {ACCESS_TOKEN}",
  "Content-Type": "application/json",
  "Origin": "https://fleetedge.home.tatamotors",
  "User-Agent": "Mozilla/5.0"
}
```

⸻

5. Vehicle Discovery (Optional but Recommended)

Endpoint
```
curl 'https://cvp.api.tatamotors/api/vehicle-service/get-vehicles' \
  -H 'Authorization: Bearer <ACCESS_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "fleet_id": "<FLEET_ID>",
    "page_number": 1,
    "page_size": 1000
  }'
```
Purpose
	•	Validate token works
	•	Confirm fleet access
	•	Map VINs (future-proofing)

⸻

6. Fuel Consumption Fetch (Primary Target)

Endpoint

POST `/api/vehicle-service/analyse-fuel-consumption`

Prototype Strategy
	•	One date range
	•	No VIN filtering
	•	Single page

```cURL

curl 'https://cvp.api.tatamotors/api/vehicle-service/analyse-fuel-consumption' \
  -H 'Authorization: Bearer <ACCESS_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "page_number": 1,
    "sort": "desc",
    "field_name": "fuel_used",
    "fleet_id": "<FLEET_ID>",
    "from_datetime": "2025-12-31T18:30:00.000",
    "to_datetime": "2026-01-17T16:14:00.000",
    "vins": [],
    "is_report": true,
    "data_count": 50,
    "is_tipper": false,
    "locale": "en",
    "req_by": "PORTALS"
  }'
```
Output
	•	Save raw JSON to:
	•	fuel_consumption.json

⸻

7. Token Validity Handling (Prototype-Level)
	•	Decode JWT locally
	•	Abort script if:
	•	exp < now + 60s
	•	No refresh-token flow for prototype

⸻

8. Error Handling (Minimal)
	•	401 → exit + print “Session expired”
	•	403 → exit immediately (do not retry)
	•	Network error → retry once

⸻

9. Mermaid — End-to-End Prototype Flow

sequenceDiagram
    participant P as Python Script
    participant B as Chromium Browser
    participant FE as FleetEdge UI
    participant API as Tata CVP API

    P->>B: Launch browser
    B->>FE: Open FleetEdge
    FE->>API: Login + Auth
    API-->>FE: JWT Token

    B->>P: Intercept Authorization Header
    P->>B: Close browser

    P->>API: Get Vehicles
    API-->>P: Vehicle Data

    P->>API: Analyse Fuel Consumption
    API-->>P: Fuel Report JSON

    P->>P: Save output


⸻
