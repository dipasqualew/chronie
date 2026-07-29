-- At most one delve per segment, on the same rule the keystone table follows: a segment is
-- one continuous stay in one instance at one difficulty, so the segment is the run's identity.
--
-- The delve's name is not here because the segment already carries it — a delve is an
-- instance and the segment is named for it. What a segment cannot say on its own is the tier,
-- since every delve runs at difficulty 208 whatever tier its entrance was set to, and which
-- of the delve's three-to-six stories the client rolled. The story has no name anywhere in
-- the client, only a scenario id, which is why one is stored rather than a name.
CREATE TABLE delve_runs (
    segment_id    INTEGER PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
    tier          INTEGER,
    scenario_id   INTEGER,
    started_at    INTEGER,
    completed_at  INTEGER,
    completed     INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1))
) STRICT, WITHOUT ROWID;
