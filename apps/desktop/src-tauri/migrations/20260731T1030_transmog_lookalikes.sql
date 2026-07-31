-- What somebody decided about a suggestion, as against what a measurement suggested.
--
-- The two stores behind "show possible alternatives" are measurements: one an equality between
-- mesh signatures, one a distance between thumbnails under a threshold the install cut for
-- itself. Both are **recomputed from scratch every time the game patches**, because a signature
-- naming a mesh that has moved is wrong and a thumbnail of a texture that has been repainted is
-- wrong. So a person who looked at a suggestion and said "yes, that is the same helm" has said
-- something no regeneration may throw away, and it does not belong in either file.
--
-- Both columns are `ItemAppearance.id`, which is the one number in this whole feature that
-- outlives a patch: the meshes move, the pictures are repainted, the distances all change, and
-- 11678 is still the Conqueror's Circlet. No foreign key can be written for either, because the
-- thing referred to lives in the game's files rather than in this database — a verdict about a
-- look the player later uninstalls the expansion for is simply a verdict nothing draws.
--
-- **Both answers are worth storing, and that is why there is a column rather than only a row.**
-- A rejection is not the absence of a confirmation: "somebody looked at this and said no" is
-- what stops a suggestion coming back to the top of the list every time it is opened, and it is
-- the only correction a reader can make to a measurement they cannot otherwise argue with. A
-- suggestion nobody has ruled on has no row here at all, which is the third state.
CREATE TABLE transmog_lookalikes (
    -- The look somebody could not have, which is what the panel was opened from.
    appearance_id     INTEGER NOT NULL,
    -- And the look that was offered in its place.
    alternative_id    INTEGER NOT NULL,
    verdict           TEXT NOT NULL CHECK (verdict IN ('yes', 'no')),
    created_at        INTEGER NOT NULL,
    PRIMARY KEY (appearance_id, alternative_id)
) STRICT, WITHOUT ROWID;
