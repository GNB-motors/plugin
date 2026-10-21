/**
 * P1 option (a): iALERT capture scripts are declared statically in the
 * manifest (no runtime registration, no "scripting" permission).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../../../manifest.json', import.meta.url), 'utf-8')
);
const IALERT = 'https://ialert.ashokleyland.com/*';

describe('manifest — iALERT (option a)', () => {
  it('declares the MAIN-world spy and the ISOLATED reader, both at document_start (no early message lost)', () => {
    const scripts = manifest.content_scripts.filter((c) => c.matches.includes(IALERT));
    expect(scripts).toEqual([
      {
        matches: [IALERT],
        js: ['src/content/ialertSessionSpy.js'],
        run_at: 'document_start',
        world: 'MAIN',
      },
      {
        matches: [IALERT],
        js: ['src/content/ialertSessionReader.js'],
        run_at: 'document_start',
        world: 'ISOLATED',
      },
    ]);
  });

  it('adds no new permission and keeps FleetEdge hosts optional', () => {
    expect(manifest.permissions).toEqual(['storage', 'alarms', 'notifications', 'browsingData']);
    expect(manifest.permissions).not.toContain('scripting');
    expect(manifest.optional_host_permissions).toContain('https://fleetedge.home.tatamotors/*');
    // The Connect-iALERT flow finds tabs through the reader's IALERT_TAB_READY
    // ping, precisely so iALERT never needs to become a host permission.
    expect(manifest.host_permissions).toEqual(['https://api.app.gnbedge.in/*']);
    expect(manifest.optional_host_permissions).not.toContain(IALERT);
  });
});
