# The player's own transmog sets

What the game calls a set the player made, which of the client's several set systems that
is, and what an addon is allowed to do to one.

This exists because the question "can Chronie keep the app's sets and the game's sets in
step" has one answer per system and three of the systems look alike from outside. Everything
below was read off a real install rather than inferred.

**Provenance.** The API surface, the namespaces and the events were read out of the
`12.0.5.67823` client binary on 2026-07-28. The signatures, argument types and taint
annotations come from that build's own `Blizzard_APIDocumentationGenerated`, and the usage
below from `Blizzard_FrameXML/WardrobeCustomSets.lua`, which is the client's own manager for
the same API. Nothing here is on the community's say-so.

## Three things called a set

The client has three, and only one of them is the thing this repository means by "a set the
player made".

**`TransmogSet`** is Blizzard's — the tier sets and the vendor sets, rows in a DB2 table,
the same for everybody. `docs/game-files.md` covers reading it, and it is what the transmog
view's first browser shows. Nobody creates one.

**A custom set** is the player's. It is a saved list of appearances under a name, held by
the server against the account, and it is what the old wardrobe "outfit" became: the client
carries a `TransmogCustomSetsMigration` step that moved them over. This is the one the app
syncs.

**An outfit** is new in Midnight and is *not* the same thing. It is a wardrobe slot the
character actually wears, in `C_TransmogOutfitInfo`: unlocked with gold
(`GetNextOutfitCost`, `GetNumberOfOutfitsUnlockedForSource`), capped per source
(`GetMaxNumberOfTotalOutfitsForSource`), assembled as *pending* changes and then paid for in
one go with `CommitAndApplyAllPending`. An outfit can be filled from a custom set in one
call — `SetOutfitToCustomSet(transmogCustomSetID)` — which is exactly the seam between the
two systems. Chronie does not write outfits, and should not: every write costs the player
money and needs the transmogrifier, so an app doing it behind their back would be spending
gold nobody asked it to spend.

## The custom set API

All of it on `C_TransmogCollection`, all of it on the 12.0.5.67823 client:

| Call | Shape |
|---|---|
| `GetCustomSets()` | `table` of `customSetID` numbers, walked with `ipairs` |
| `GetCustomSetInfo(customSetID)` | `name`, `icon` — may return nothing |
| `GetCustomSetItemTransmogInfoList(customSetID)` | `table` of `ItemTransmogInfo`, indexed by transmog slot — may return nothing |
| `GetNumMaxCustomSets()` | how many the account may hold at once |
| `IsValidCustomSetName(name)` | the server's own opinion of a name |
| `NewCustomSet(name, icon, itemTransmogInfoList)` | returns the new `customSetID`, or nothing |
| `ModifyCustomSet(customSetID, itemTransmogInfoList)` | replaces what is in it |
| `RenameCustomSet(customSetID, name)` | |
| `DeleteCustomSet(customSetID)` | |
| `GetCustomSetHyperlinkFromItemTransmogInfoList(list)` | a `|Hcustomset:…|h` chat link |
| `GetItemTransmogInfoListFromCustomSetHyperlink(link)` | and back again |

The event is **`TRANSMOG_CUSTOM_SETS_CHANGED`**, which the client fires without saying which
set changed or how — the same shape as `EQUIPMENT_SETS_CHANGED`, and answered the same way,
by keeping the last look and subtracting.

An `ItemTransmogInfo` is `{ appearanceID, secondaryAppearanceID, illusionID }`, and
`appearanceID` is a *source* id — an `ItemModifiedAppearance` row — which is the same number
the app already stores as `CustomSetPiece.appearanceId`. `Constants.Transmog.NoTransmogID`
is what an empty slot holds, not `nil`.

**None of the write calls is protected.** Every one is documented `SecretArguments =
"AllowedWhenUntainted"` and nothing more; there is no protected flag, no hardware-event
requirement, and no transmogrifier in the loop. Saving a custom set is a collection
operation, not a transmogrification, so it costs nothing and works anywhere. That is what
makes syncing them possible at all, and it is the single fact the whole feature rests on.

## What that means for syncing

**Game to app works as written.** The addon reads the sets, files them in SavedVariables and
the app picks them up when the client dumps the file at logout — the same road every other
thing Chronie collects already travels.

**App to game cannot go through SavedVariables.** The client reads a SavedVariables file
once, at `ADDON_LOADED`, and rewrites *the whole file* from memory at logout or reload.
Anything the app writes into `ChronieDB.lua` while the game is running is therefore never
read and then destroyed. The proposal in issue #141 — "the desktop app writes to
SavedVariables a reference and the addon updates the set" — is sound in its shape and wrong
in its address.

The address that works is **a file of the addon's own**, listed in `chronie.toc` and loaded
like any other source file. The client never writes those, so the app owns it outright, and
the addon reads whatever is in it at load. The app already installs the addon, so it already
has the folder and the right to write there.

That road is now carrying a second thing. `src/CensusRequests.lua` is the same shape with a much
simpler payload — a reader asking for the account's collections to be walked again — and
`docs/account-census.md` is where it is argued. Everything above about the address holds for it:
picked up at the next load, answered at the next logout, and written into the addon's folder on
every install so an ask survives one.
