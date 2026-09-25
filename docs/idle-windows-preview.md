# Durable Windows preview host

This is the workstation-specific preview path. It complements the Debian VM
production runbook; it is not the eventual production topology.

## Security boundary

Only the password-gated gateway on `127.0.0.1:3100` may be tunneled. Never
tunnel the raw authority, Vite, or OpenFront worker ports.

```text
browser -> Cloudflare HTTPS -> 127.0.0.1:3100 preview gateway
                                  |-- exact idle HTML/CSS/JS allowlist
                                  `-- exact session/state/tap API proxy
                                                   |
                                                   v
                                      127.0.0.1:3000 idle authority
                                                   |
                                                   v
                                  C:\ProgramData\OpenFrontIdle\data
```

The gateway requires a preview password, uses a secure HTTP-only cookie,
limits login attempts and request bodies, overwrites forwarded client IP data,
adds browser security headers, and returns `404`/`405` for everything outside
the idle allowlist. The standalone authority binds only to loopback and always
disables the admin endpoint.

## Install or refresh supervision

Run elevated PowerShell from the repository:

```powershell
.\deploy\windows\install-pressure-atlas-preview.ps1 `
  -Workspace $PWD `
  -NodeRuntimeRoot ..\.runtime\node-v24.18.1-win-x64 `
  -CloudflaredSource C:\path\to\the\verified\cloudflared.exe `
  -ExistingDatabase .\.data\idle-demo.sqlite
```

The installer:

- verifies the Cloudflare Authenticode signature;
- keeps the database, secrets, bounded logs, run state, and backups under
  ACL-restricted `C:\ProgramData\OpenFrontIdle`;
- migrates an existing WAL database with Node's online SQLite backup API and
  verifies both copies with `PRAGMA integrity_check`;
- registers direct `Authority`, `Gateway`, and `Tunnel` startup tasks under
  `NT AUTHORITY\LOCAL SERVICE`, plus a SYSTEM watchdog that repairs a hung
  component without giving the network-facing processes elevated privileges;
- registers a daily verified SQLite backup and prunes recovery copies after
  fourteen days.

The installer prints the preview password once. It remains in the protected
runtime configuration and is intentionally never committed or placed in task
arguments.

Standalone client asset edits are read from the checkout on each request.
After a backend TypeScript edit, restart only the direct authority task:

```powershell
Stop-ScheduledTask -TaskPath \OpenFrontIdle\ -TaskName Authority
Start-ScheduledTask -TaskPath \OpenFrontIdle\ -TaskName Authority
```

## Runtime inspection

```powershell
Get-ScheduledTask -TaskPath \OpenFrontIdle\
Get-Content C:\ProgramData\OpenFrontIdle\run\public-url.txt
Invoke-RestMethod http://127.0.0.1:3000/api/idle/health
Invoke-WebRequest http://127.0.0.1:3100/__preview/login -UseBasicParsing
```

The `Tunnel` task initially uses a Cloudflare Quick Tunnel. Its HTTPS URL is
written to `run\public-url.txt`. It reconnects automatically, but the random
hostname can change after a connector restart and Cloudflare gives Quick
Tunnels no uptime guarantee. After named-tunnel cutover, a uniquely named
delayed-auto Windows service runs the stable connector; Service Control Manager
recovery and the watchdog supervise it independently from the application.

## Stable hostname cutover

Create a separate locally managed tunnel for this preview; do not edit the
Sightings production tunnel. The current public hostname is
`atlas-dev.sightings.today`, pointing to `http://127.0.0.1:3100`.

The high-entropy gateway password is the authentication boundary for the
owner-only preview. Before sharing the hostname with anyone else, add a
Cloudflare Access application restricted to the owner's exact identity and
enable Access JWT validation in the ingress configuration.

Cutover checklist:

1. Put a dedicated signed executable, tunnel-scoped credential, exact-host
   ingress configuration, and logs under a protected
   `C:\ProgramData\OpenFrontIdle\named-tunnel` subtree. The final ingress rule
   must be `http_status:404`.
2. Run it as the unique delayed-auto service
   `CloudflaredPressureAtlasDev`, with a service SID, Local Service identity,
   and restart-on-failure rules. Do not reuse the default `cloudflared` service
   or the Sightings connector.
3. Set `TunnelMode` to `service`, `NamedTunnelServiceName` to that service,
   `CloudflaredConfigPath` to its configuration, and `PublicUrl` to the stable
   HTTPS URL in the protected runtime JSON. Keep the quick scheduled task
   disabled as a rollback path.
4. Verify that admin, health, OpenFront assets, Vite, workers, missing files,
   wrong methods, and WebSocket upgrades all remain inaccessible publicly.
5. Stop/restart the authority and connector independently, then perform one
   reboot test and confirm the same hostname and SQLite player state return.

Cloudflare references:

- [Run cloudflared as a Windows service](https://developers.cloudflare.com/tunnel/advanced/local-management/as-a-service/windows/)
- [Tunnel credential permissions](https://developers.cloudflare.com/tunnel/advanced/local-management/tunnel-permissions/)
- [Ingress configuration](https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/)
- [Validate Access JWTs at the origin](https://developers.cloudflare.com/tunnel/advanced/origin-parameters/)
- [Access policy behavior](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)

The LAN URL and stable HTTPS hostname are different browser origins, so iOS
local storage does not migrate between them. A first HTTPS visit creates a new
preview guest unless the player deliberately uses a future recovery flow.

## Host caveats

- The Windows VM cannot ensure recovery after a Proxmox host reboot. Enable VM
  autostart in Proxmox.
- This Windows Server evaluation expires January 28, 2027.
- Do not delete `C:\ProgramData\OpenFrontIdle` when rotating dated workspaces;
  it is the durable game state.
- The dev tasks intentionally execute the current checkout and pinned Node
  runtime. Do not move or delete either path without rerunning the installer
  from the new checkout first.
