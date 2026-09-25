# Managed development startup

Current source: [mushroomlemonade/idlefront](https://github.com/mushroomlemonade/idlefront).
The September notes below describe the previous runtime, not a completed
repository cutover. Follow [repository migration](repository-migration.md)
before changing a running installation. Publishing source does not repoint tasks.

Status: installed manually September 10; all four tasks verified Running.
Public SDK 57 manifest, iOS bundle (3,887,888 bytes), icon and authenticated web
page returned HTTP 200. Real iPhone loading and reboot recovery are not yet verified.
The proxy now preserves Metro's expo-protocol-version and expo-sfv-version headers;
both were verified through Atlas after the legacy-manifest error was reported.
Initial S4U startup failed with Windows error 1909 (account locked out). The user
explicitly authorized unlocking the local Administrator account; after unlocking
without changing password or policy, the tasks started successfully. This does
not establish the cause of the earlier Codex command-policy rejection.

## September 10 RDP restriction

Security event 4625 showed repeated Administrator wrong-password network logons
from public addresses immediately before another 4740 lockout. With explicit user
authorization, the three enabled RemoteDesktop allow rules were scoped to
192.168.2.0/24. Explicit TCP/UDP port 3389 block rules named IdleFront-RDP-* cover
the IPv4 complement of that subnet and all IPv6 (this host has only IPv4 LAN).
All rules apply to every firewall profile. The original firewall was exported to
C:\ProgramData\OpenFrontIdle\config\firewall-before-lan-rdp-20260910.wfw.
No passwords, lockout policy, router rules, or other ports were changed. The
account was unlocked after rule verification and Gateway restarted successfully.
External reachability still requires a test from outside the LAN; do not claim a
complete security audit or use a full firewall restore casually.
Activation is a one-time manual operation because the agent's gateway replacement
was rejected by its execution policy. Do not use this installer as an alternate
agent execution route for the rejected operation.

## Install once

Open PowerShell **as administrator using your normal Administrator Windows account**:

```powershell
# Run from the intended new checkout, after reviewing the migration checklist.
& .\scripts\install-dev-startup.ps1 -NodePath (Get-Command node).Source
```

No execution-policy override is included. If Windows rejects the script, retain
the exact error for investigation rather than disabling that protection.

The installer derives `Workspace` from its own location. It requires the existing
protected runtime configuration, a compatible Node installation, and installed
root/mobile dependencies; it is not a general fresh-machine bootstrap. It also
reads the legacy `runtime.json`, so reconcile that configuration with the current
`dev-runtime.json` before using it for a checkout migration. Preserve database
paths, preview credentials and the stable Node runtime. Review scheduled Backup
tasks separately. No tasks or configuration were changed by the documentation update.

The installer registers startup tasks under `\OpenFrontIdle\` for Gateway, Expo,
Web, and Backend. They run as the installing user with a limited S4U token, not
SYSTEM, and do not require a stored password. S4U does not support Windows
integrated network credentials or encrypted EFS files; this setup uses local
files and the existing independent Cloudflare service.

- Node is copied once into `C:\ProgramData\OpenFrontIdle\dev-runtime` so a Codex
  update cannot silently remove its executable. Node upgrades are separate work.
- New runtime config is `C:\ProgramData\OpenFrontIdle\config\dev-runtime.json`.
  Original config, database paths and Cloudflare service remain untouched.
- Task exports and the previous dev config are saved under `.dev-logs/managed/setup-*`.
  Treat these files as private: configuration contains the preview credential.
- Only the existing Gateway task is stopped during installation. Other active
  listeners are left alone. Supervisors wait for their ports to become free.
- Process exits trigger a bounded restart backoff. There is no periodic game
  restart and no timeout-based killing of a slow or busy game.
- Each launch writes a dated log under `.dev-logs/managed`. Logs are not pruned
  automatically; monitor disk use during prolonged development.
- Expo remains loopback-only. Atlas exposes the scoped manifest/bundle/assets
  proxy; the bearer link must be kept private. Fast Refresh through this proxy
  is not yet verified; reloading Expo Go may be needed for native-shell changes.

## After installation

Verify all four listeners, then fetch the public Expo manifest, its rewritten
bundle and icon through Atlas. Check normal preview authentication. A real
Expo Go load and a reboot test are still necessary before calling this fully
validated. Do not restart an active game just to perform the reboot test.

## Rollback

Stop the four managed tasks using Task Scheduler. Restore each existing task
from its saved XML through Task Scheduler's Import Task command. Tasks without
a previous XML (normally Expo, Web and Backend) can be deleted. Restore the
previous `dev-runtime.json` if one was saved. This does not delete any games or
modify the original runtime config. The old Gateway XML points at the recovery
checkout, so restoring it also removes the new Atlas Expo route.

The disabled legacy Authority/Watchdog tasks remain disabled. The existing
Backup task still targets its original configuration; migrating database backups
is separate work, not a benefit claimed by this installer.
