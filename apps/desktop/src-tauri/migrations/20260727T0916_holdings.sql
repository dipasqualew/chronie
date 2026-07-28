-- What a gain left behind, alongside the gain itself.
--
-- A gain on its own cannot answer the only question worth asking about it: a currency line
-- reading "+15" says nothing about whether there is now enough to buy anything, and a
-- reputation line reading "+250" says nothing about how far that moved the faction. The
-- addon already reads both off the client at the moment of the change and writes them into
-- SavedVariables; these are the columns that stop them being dropped on the way in.
--
-- Every one of them is nullable, because every one of them can genuinely be unknown: an
-- item-based currency counted before its first change has no holding to report, and a
-- reputation gain parsed out of chat for a faction the client will not place — an
-- account-wide line read on a character that has never met them — has no standing at all.
-- A NULL here means "the client did not say", which is a different thing from zero.
ALTER TABLE currency_gains ADD COLUMN total INTEGER;

-- Named for the standing rather than the faction's raw reputation, because which of the
-- client's four reputation systems answers for a faction decides what the pair means:
-- renown counts levels of its own, paragon fills the same bar over and over, a friendship
-- has ranks with their own names, and the rest is the reaction ladder. The addon has
-- already picked between them, so what arrives is always the same shape — how far into the
-- current level the character is, and how long that level is.
ALTER TABLE reputation_gains ADD COLUMN standing TEXT;
ALTER TABLE reputation_gains ADD COLUMN standing_current INTEGER;
ALTER TABLE reputation_gains ADD COLUMN standing_max INTEGER;
