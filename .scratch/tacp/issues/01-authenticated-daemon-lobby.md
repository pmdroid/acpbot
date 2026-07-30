# 01 — Authenticated daemon with a working lobby

**What to build:** The operator can start the daemon and talk to their bot. Sending
`/ping` in the root area of the private chat gets a reply. Anyone else messaging
the bot gets nothing at all — no reply, no error, no trace. If the bot is not
configured for topic mode, the daemon refuses to start and says why, rather than
running in a state where sessions can never be created.

This is the walking skeleton: it establishes the single `Environment` edge port,
the fake environment, and the test harness that every later ticket rides on.
Nothing internal to the daemon core is mocked, now or later — if something is hard
to test, drive it from the edge rather than opening a new seam.

The `Environment` port carries telegram (send, edit message, edit topic, create
topic, answer callback, update source), agents, clock, and store. Agents and store
may be stubs at this stage, but the port shape is settled here. The clock is
injected rather than ambient — later tickets cannot test an unanswered permission
without advancing it.

Configuration must not assume local filesystem paths, locally cached credentials,
or a TTY. Where the bot token and operator id come from is configuration; the
daemon reads them through the port.

**Blocked by:** None — can start immediately. Demoing against a real bot needs
wayfinder ticket 008 (bot provisioning); the tests do not.

**Status:** ready-for-agent

- [ ] `/ping` in the root area gets a reply
- [ ] An update from any sender other than the allowlisted operator produces zero
      outbound calls — asserted, not merely "handled"
- [ ] Startup asserts `getMe.has_topics_enabled` and exits with a clear message
      when false
- [ ] A redelivered update produces no duplicate effect (at-least-once delivery,
      offset-as-ack)
- [ ] `getUpdates` 409 conflict is handled rather than crashing the daemon —
      relevant when a restart overlaps a dying predecessor
- [ ] Tests drive the real core over a fake environment and assert on outbound
      telegram calls; no internal module is mocked
- [ ] No configuration path assumes a local filesystem layout, cached credentials,
      or a TTY
