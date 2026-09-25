# Codex command execution incident — September 10, 2026

## Symptom

IdleFront development service startup commands are rejected before execution with `exec_command failed: CreateProcess ... Rejected(... rejected: blocked by policy)`.
Read-only PowerShell commands and a read-only Node SQLite diagnostic execute successfully.
The rejected commands use PowerShell Start-Process with WindowStyle Hidden to launch the project's Node services. Both a multi-service command and a gateway-only startup were rejected. The multi-service form initially included stopping verified existing service PIDs; startup-only retries were also rejected.

## Verified observations

- User configuration specifies approval_policy = "never" and sandbox_mode = "danger-full-access".
- Runtime diagnostic entry at 2026-09-10 12:10:03 UTC independently records approval_policy=Never and sandbox_policy=DangerFullAccess during the failing turn.
- Gateway-only rejection occurred at 12:10:03 UTC; tool call ID exec-0e50e189-f03c-42db-a60f-ac66668c9b0a.
- No user rules directory or rules directories at the two checked project config locations were found. This does not exclude managed or built-in policy.
- Repeated user permission changes and restarting the application did not resolve the observed rejection.
- Desktop logs show app build 26.903.8094.0 after restart. Earlier logs reference 26.901.6511.0. This is correlation, not evidence that an update caused the problem.
- The desktop log and targeted execution log entries contain no rejecting rule identifier or explanatory policy rationale.

## Diagnosis boundaries

This is an execution-policy rejection, not evidence of a Windows elevation failure. The exact enforcing policy and reason remain unknown. Administrator mode is not an established fix. The failure is not evidence that all commands or all writes are blocked.

## Suggested support request

Please identify why these authorized local development-service launches are rejected under runtime-confirmed DangerFullAccess/Never, and expose the specific rule or policy reason. Explain whether this is expected managed policy, command classification, or a product defect, and provide a supported resolution.

No authentication files, cookies, full diagnostic database, or raw session logs are included in this report. Nothing has been submitted externally. Security configuration has not been changed.
