#!/usr/bin/env python3
"""
FleetEdge Fuel Consumption Prototype Scraper

Captures JWT token from FleetEdge browser session, decodes fleet_id,
and fetches fuel consumption data via direct API calls.
"""

import argparse
import asyncio
import csv
import json
import os
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import jwt
from playwright.async_api import async_playwright


# Constants
FLEETEDGE_HOME_URL = "https://fleetedge.home.tatamotors/"
CVP_API_BASE = "https://cvp.api.tatamotors"
FLEETEDGE_ORIGIN = "https://fleetedge.home.tatamotors"
DEFAULT_TIMEOUT = 300
DEFAULT_OUTPUT_DIR = "scripts/output"
DEFAULT_PW_DATA_DIR = "scripts/.pw-data"
TOKEN_EXPIRY_BUFFER_SECONDS = 60


def redact_token(token: str) -> str:
    """Return redacted token preview (first 6 + last 4 chars)."""
    if len(token) <= 10:
        return "***"
    return f"{token[:6]}…{token[-4:]}"


def format_datetime_utc(dt: datetime) -> str:
    """Format datetime as YYYY-MM-DDTHH:MM:SS.mmm (UTC, no offset suffix)."""
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(dt.microsecond/1000):03d}"


def compute_date_range_ist_to_utc():
    """Compute from_datetime (today 00:00 IST) and to_datetime (now IST), convert to UTC."""
    from zoneinfo import ZoneInfo

    ist = ZoneInfo("Asia/Kolkata")
    now_ist = datetime.now(ist)
    from_ist = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    to_ist = now_ist

    from_utc = from_ist.astimezone(timezone.utc)
    to_utc = to_ist.astimezone(timezone.utc)

    return from_utc, to_utc, from_ist, to_ist


def decode_jwt_token(token: str) -> dict:
    """Decode JWT without signature verification (prototype)."""
    try:
        payload = jwt.decode(
            token,
            options={"verify_signature": False, "verify_aud": False}
        )
        return payload
    except jwt.DecodeError as e:
        raise ValueError(f"Failed to decode JWT: {e}")


def check_token_expiry(payload: dict) -> None:
    """Check if token expires within buffer time. Abort if too close to expiry."""
    exp = payload.get("exp")
    if not exp:
        raise ValueError("JWT payload missing 'exp' claim")

    exp_dt_utc = datetime.fromtimestamp(exp, tz=timezone.utc)
    now_utc = datetime.now(timezone.utc)
    buffer_time = now_utc + timedelta(seconds=TOKEN_EXPIRY_BUFFER_SECONDS)

    if exp_dt_utc < buffer_time:
        print(f"ERROR: Token too close to expiry")
        print(f"  Expiry (UTC): {exp_dt_utc.isoformat()}")
        print(f"  Current (UTC): {now_utc.isoformat()}")
        sys.exit(1)


async def capture_token(
    pw_data_dir: Path,
    timeout_seconds: int,
    headless: bool
) -> str:
    """
    Launch Playwright browser, navigate to FleetEdge, capture JWT token
    from outbound requests matching strict filter.
    """
    token_event = asyncio.Event()
    captured_token: Optional[str] = None

    def handle_request(request):
        """Intercept requests and capture token if matching strict filter."""
        nonlocal captured_token

        if token_event.is_set():
            return

        url = request.url
        parsed = urlparse(url)

        # Strict filter: host + path prefix + Authorization header
        if (
            parsed.hostname == "cvp.api.tatamotors"
            and parsed.path.startswith("/api/vehicle-service/")
        ):
            auth_header = request.headers.get("authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header[7:]  # Remove "Bearer " prefix
                captured_token = token
                token_event.set()
                print(f"✓ Token captured: {redact_token(token)}")

    async with async_playwright() as p:
        browser = await p.chromium.launch_persistent_context(
            user_data_dir=str(pw_data_dir),
            headless=headless,
            args=["--disable-blink-features=AutomationControlled"]
        )

        try:
            # Get or create page
            pages = browser.pages
            if pages:
                page = pages[0]
            else:
                page = await browser.new_page()

            page.on("request", handle_request)

            print(f"Opening {FLEETEDGE_HOME_URL}")
            print("Please log in and open Reports → Fuel Consumption page.")
            await page.goto(FLEETEDGE_HOME_URL, wait_until="domcontentloaded")

            # Wait for token with timeout
            try:
                await asyncio.wait_for(token_event.wait(), timeout=timeout_seconds)
            except asyncio.TimeoutError:
                print("\nERROR: Token capture timeout")
                print(
                    "Login detected, but no vehicle-service API call observed. "
                    "Please open the Fuel Consumption report page."
                )
                sys.exit(1)

            if not captured_token:
                print("ERROR: Token event set but token is None")
                sys.exit(1)

            return captured_token

        finally:
            await browser.close()




async def fetch_fuel_consumption_async(
    token: str,
    fleet_id: str,
    from_datetime: str,
    to_datetime: str
) -> dict:
    """
    Call analyse-fuel-consumption API using Playwright (bypasses SSL issues).
    Returns full JSON response.
    """
    url = f"{CVP_API_BASE}/api/vehicle-service/analyse-fuel-consumption"

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Origin": FLEETEDGE_ORIGIN,
        "User-Agent": "Mozilla/5.0"
    }

    payload = {
        "page_number": 1,
        "sort": "desc",
        "field_name": "fuel_used",
        "fleet_id": fleet_id,
        "from_datetime": from_datetime,
        "to_datetime": to_datetime,
        "vins": [],
        "is_report": True,
        "data_count": 50,
        "is_tipper": False,
        "locale": "en",
        "req_by": "PORTALS"
    }

    print(f"Calling fuel consumption API...")
    print(f"  Fleet ID: {fleet_id}")
    print(f"  Date range: {from_datetime} to {to_datetime}")

    # Use Playwright to make the API call - bypasses LibreSSL SSL issues
    # Playwright uses Chromium's networking stack which has proper TLS support
    max_retries = 2
    last_exception = None

    for attempt in range(max_retries):
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                context = await browser.new_context()
                page = await context.new_page()

                try:
                    response = await page.request.post(
                        url,
                        headers=headers,
                        data=json.dumps(payload)
                    )

                    status = response.status

                    if status == 401:
                        print("ERROR: Session expired (401)")
                        sys.exit(1)

                    if status == 403:
                        print(f"ERROR: Forbidden (403)")
                        print(f"  Endpoint: {url}")
                        print(f"  Payload: {json.dumps(payload, indent=2)}")
                        sys.exit(1)

                    if status != 200:
                        response_text = await response.text()
                        print(f"ERROR: API returned status {status}")
                        print(f"  Endpoint: {url}")
                        print(f"  Payload: {json.dumps(payload, indent=2)}")
                        print(f"  Response: {response_text[:500]}")
                        sys.exit(1)

                    response_json = await response.json()
                    return response_json

                finally:
                    await browser.close()

        except Exception as e:
            last_exception = e
            if attempt < max_retries - 1:
                print(f"Network error (attempt {attempt + 1}/{max_retries}): {e}")
                await asyncio.sleep(2)
            else:
                print(f"ERROR: Network request failed after {max_retries} attempts")
                print(f"  {e}")
                sys.exit(1)

    raise RuntimeError("Unreachable")


def fetch_fuel_consumption(
    token: str,
    fleet_id: str,
    from_datetime: str,
    to_datetime: str
) -> dict:
    """
    Synchronous wrapper for async fuel consumption fetch.
    """
    return asyncio.run(fetch_fuel_consumption_async(token, fleet_id, from_datetime, to_datetime))


def write_outputs(
    response_json: dict,
    output_dir: Path,
    from_ist: datetime,
    to_ist: datetime
) -> tuple[str, str]:
    """
    Write JSON and CSV outputs to output_dir.
    Returns (json_path, csv_path).
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # Filename components: use IST dates for readability
    from_str = from_ist.strftime("%Y-%m-%d")
    to_str = to_ist.strftime("%Y-%m-%d")
    timestamp = int(time.time())

    json_filename = f"fuel_consumption_{from_str}_{to_str}_{timestamp}.json"
    csv_filename = f"fuel_consumption_{from_str}_{to_str}_{timestamp}.csv"

    json_path = output_dir / json_filename
    csv_path = output_dir / csv_filename

    # Write JSON
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(response_json, f, indent=2, ensure_ascii=False)

    print(f"✓ JSON saved: {json_path}")

    # Write CSV from results[]
    results = response_json.get("results", [])
    if results:
        # Union of all keys across rows
        columns = sorted(set().union(*(row.keys() for row in results)))

        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=columns)
            writer.writeheader()
            for row in results:
                # Fill missing keys with empty string
                writer.writerow({col: row.get(col, "") for col in columns})

        print(f"✓ CSV saved: {csv_path}")
    else:
        print("⚠ No results in response, skipping CSV")

    return str(json_path), str(csv_path)


def main():
    parser = argparse.ArgumentParser(
        description="FleetEdge Fuel Consumption Prototype Scraper"
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="Delete persistent browser data before launch"
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=DEFAULT_TIMEOUT,
        help=f"Token capture timeout in seconds (default: {DEFAULT_TIMEOUT})"
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run browser in headless mode (default: visible)"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Output directory for JSON/CSV files (default: {DEFAULT_OUTPUT_DIR})"
    )

    args = parser.parse_args()

    # Setup paths
    script_dir = Path(__file__).parent
    pw_data_dir = script_dir / ".pw-data"
    output_dir = Path(args.output_dir)

    # Handle --fresh flag
    if args.fresh and pw_data_dir.exists():
        print(f"Deleting persistent browser data: {pw_data_dir}")
        shutil.rmtree(pw_data_dir)

    # Compute date range
    from_utc, to_utc, from_ist, to_ist = compute_date_range_ist_to_utc()
    from_datetime_str = format_datetime_utc(from_utc)
    to_datetime_str = format_datetime_utc(to_utc)

    print("=" * 60)
    print("FleetEdge Fuel Consumption Prototype")
    print("=" * 60)
    print(f"Date range (IST): {from_ist.strftime('%Y-%m-%d %H:%M:%S')} to {to_ist.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Date range (UTC): {from_datetime_str} to {to_datetime_str}")
    print()

    # Capture token
    token = asyncio.run(
        capture_token(
            pw_data_dir,
            args.timeout_seconds,
            args.headless
        )
    )

    # Decode JWT
    print("\nDecoding JWT token...")
    payload = decode_jwt_token(token)
    fleet_id = payload.get("fleet_id")
    if not fleet_id:
        print("ERROR: JWT payload missing 'fleet_id' claim")
        sys.exit(1)

    exp = payload.get("exp")
    if exp:
        exp_dt_utc = datetime.fromtimestamp(exp, tz=timezone.utc)
        print(f"  Fleet ID: {fleet_id}")
        print(f"  Token expiry (UTC): {exp_dt_utc.isoformat()}")

    # Check expiry
    check_token_expiry(payload)

    # Fetch fuel consumption data
    print()
    response_json = fetch_fuel_consumption(
        token,
        fleet_id,
        from_datetime_str,
        to_datetime_str
    )

    # Write outputs
    print()
    json_path, csv_path = write_outputs(response_json, output_dir, from_ist, to_ist)

    print()
    print("=" * 60)
    print("✓ Success!")
    print(f"  Results: {response_json.get('total_results', 0)} vehicles")
    print(f"  JSON: {json_path}")
    if csv_path:
        print(f"  CSV: {csv_path}")
    print("=" * 60)


if __name__ == "__main__":
    main()
