# Development workflow recovery — September 10

## Plan and verified results

1. Preserve project/history and existing services; no .codex reset or antivirus changes.
2. Isolate launcher mechanics using Node --version only: hidden Start-Process, output redirection, and a benign environment variable all succeeded. Node reports v24.19.0.
3. Test Expo with less exposure: start --go --localhost --port 8081 succeeded using the normal execution tool, without a tunnel. Metro responds packager-status:running.
4. Correct loopback routing: Expo localhost binds ::1, not 127.0.0.1, on this machine. The pending Atlas Expo proxy now uses localhost accordingly.
5. Reconcile the gateway deployment after supported activation: current gateway PID 2880 imports scripts from the OLD checkout via idle-windows-launcher.mjs. Backend and frontend use the new checkout. Do not silently patch the recovery copy or change another launcher to evade a rejected action.
6. Obtain a supported approval/resolution for the rejected gateway replacement. Official documentation describes /approve for recent automatic-review denials; applicability to this error and desktop availability remain unverified. No permission policy is weakened.
7. Once activation is authorized, verify the public manifest, bundle, icon, unauthorized-route rejection, and real iPhone loading. Only then call the stable Expo URL ready.

## Remaining uncertainty

No exact policy rule or enforcing component has been identified. A blanket Node, Start-Process, Expo-installation, or Windows filesystem-permission failure is contradicted by successful probes. Local Expo startup does not establish why earlier combined or tunnel startup commands were denied. Gateway deployment mismatch and IPv6 loopback explain potential serving failures, not the pre-execution policy rejection.

Existing code edits and tests can continue. Metro is currently local-only. The public Atlas Expo route is not yet activated or end-to-end verified.
