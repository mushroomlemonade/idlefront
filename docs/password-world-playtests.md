# Password-protected playtests

In the lobby creator's Players step, choose Private and enter a Game password.
Share the invitation and password with the players. Existing invitations without
a password keep their previous behavior.

To change devices, disconnect from the map on the first device, open the same
invitation on the second, and enter the game password and the exact same username
(including capitalization). For an active game, select **Resume a nation**.
The existing nation is reused; joining does not reset its territory, units,
structures, or simulation state. This uses the existing snapshot/reconnect path.

Only one live map connection controls each nation. A second connection is refused
with instructions to disconnect the other device. A disconnected socket releases
the seat immediately; an unresponsive connection can be replaced after 30 seconds
without a heartbeat. Disconnecting does not pause or protect the nation.

This is intentionally shared-password access for trusted friends. Anyone with the
game password can claim a guest nation by its username. Linked-account nations
still require their original account. Passwords are stored as salted scrypt hashes.
Claims are scoped to one world, and gameplay credentials are signed for one runtime
game. They do not give access to that player's other worlds or account.

Player ownership and connection locks never use the client IP. Managed games omit
the upstream public-match three-per-IP admission cap. Authenticated lobby HTTP
limits are keyed to the controller identity, so players sharing a router have
separate allowances. Anonymous session creation still has a transport abuse cap.

Schema migration 7 adds password and per-world claim tables. Before rolling back
to a binary that only supports schema 6, restore a matching database backup; do
not discard the migration ledger on the live database.

Verification covers passwords, isolated world access, matching usernames,
multiple clients sharing an IP, duplicate controller rejection, disconnected and
stale sockets, token scope, and existing persistent-world migrations and flows.
Actual iOS/Expo device behavior still merits the planned friends playtest.
