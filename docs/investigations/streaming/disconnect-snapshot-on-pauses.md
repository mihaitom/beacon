# Disconnect snapshot fired on ordinary pauses (RESOLVED 2026-08-22)

**Symptom:** every pause produced `Device dropped /stream mid-track` in the
log, burying the rare real event the instrumentation existed to catch.

**Cause:** the snapshot was logged at the moment of cancellation, where it is
genuinely unknowable whether a device dropped out or one of our own handlers
closed the connection: the connection count still includes this connection
(its `finally` has not run yet) and `clock.is_paused` may not be set yet.

**Fix:** capture the numbers at cancellation (they describe that instant) but
carry them into `_mark_disconnected_if_not_reconnected()` and log them only on
the branch that has already concluded it was a real drop. This reuses the
existing, correct decision instead of inventing a second one.
