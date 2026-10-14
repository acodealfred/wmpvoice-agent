"""Admin Live Monitor — see the data of running assessments while they happen.

The assessment page sends a ~300-byte health summary once a second over its open
/realtime WebSocket (``monitor.tick``: EEG sample counts / NaNs / min-max-std per
channel, contact, lost packets, recorder cap, camera face). ``live.record_tick``
validates it into a short per-session history (``rules``), and the admin-only
``/admin/monitor/*`` routes read that history — never raw data, never the DB.

IN MEMORY ONLY, so it relies on the app's single-replica deployment (the same
constraint Litestream already imposes): with more than one replica an admin would
only see the sessions connected to the replica that served the poll.
"""
