# The account census

Everything else Chronie records is a record of something *happening*: a segment, a gain, a
kill. That is the right shape for a history and the wrong shape for a collection.

A history of gains can only ever describe an account Chronie has watched from the beginning.
An achievement earned in 2011, a mount bought on a laptop with a different install, an evening
a crash took with it — none of those is a gain anybody saw, and no amount of further watching
will produce one. Waiting fixes nothing, because the events that would have carried them have
already been and gone.

So the addon also *walks*: it asks the client what the account holds, and writes the answer
down. `apps/addon/src/Census.lua` is the walk and `apps/addon/src/CensusDomains.lua` is the
adapters over it. `apps/desktop/src-tauri/src/collector/census.rs` receives it.

## The rule everything turns on

> **An absence means a removal only inside a reading that says it is complete.**

A walk sets `complete = false` the moment it starts and `true` only when it has asked about
every id the client named. Everything in between is half of one reading beside half of
another, which is a position the account was never in — and for as long as that is true the
file says so out loud.

The collector therefore adds and updates from any reading, and deletes from a complete one
only. That one asymmetry is what makes every partial case safe without a case of its own:

- a logout part-way through a walk,
- a client build with no such API, which reports nothing rather than an empty list,
- an addon older than the app, which has never written the domain at all,
- a character that can only see part of what the account owns.

None of those needs detecting. Each arrives with the flag down and is read as a set of
positive observations, which is exactly what it is.

## Why there is no daily full sync

**A pass is provoked, not scheduled.** This is the part worth arguing for, because "re-sync
every day" is the obvious design and it is both more expensive and less accurate.

Every domain the census covers is *also* fed by a client event for as long as the addon is
loaded — `NEW_MOUNT_ADDED`, `ACHIEVEMENT_EARNED`, `NEW_PET_ADDED`, `NEW_TOY_ADDED`,
`TRANSMOG_COLLECTION_SOURCE_ADDED`, `CURRENCY_DISPLAY_UPDATE`, `QUEST_TURNED_IN`. Between two
walks the record keeps itself, and a walk changes nothing. A daily walk would spend thirteen
thousand client calls to confirm what the events already knew.

What the events genuinely cannot cover is a short list, and every item on it is *detectable*:

| What happened out of sight | How it is noticed |
|---|---|
| Chronie was never installed / this is the first run | no completed pass |
| A patch added mounts, retired achievements, moved appearances | the stored `build` differs from `GetBuildInfo` |
| A session a crash took with it | the client's own counter is higher than what was stored |
| An evening played on another machine's install | the same counter |
| A character never seen before | that character's domains have no completed pass |

`census.audit` is those checks, and it costs a handful of calls at every load screen. In the
steady state it names nothing and no walk starts at all.

The counter is the interesting one, because it turns "we might have missed something" into
"we did". `GetNumCompletedAchievements(guildView)` returns `numAchievements, numCompleted` —
read out of Blizzard's own `Blizzard_AchievementUI` on 12.0.5.67823 rather than assumed — so
one call gives the account's completed total, and comparing it to the number of rows stored is
cheap.

**The comparison is `counted > held`, not `counted ~= held`, and the asymmetry is deliberate.**
A count above what is written down means things are missing, which is what a walk is for. A
count *below* it is ambiguous, because the counter need not be counting the same set: whether
`GetNumCompletedAchievements` includes guild achievements — which the domain deliberately
refuses to record, since they belong to a guild rather than to the account — could not be
settled from the install. If it does include them, a `~=` test would provoke a full
thirteen-thousand-call walk at every login of a guilded character, forever, and change nothing
each time. **This one is worth confirming against a running client**: `GetNumCompletedAchievements(false)`
beside a finished census of the same account settles it in a single comparison.

A domain whose client offers no counter of *settled meaning* is deliberately wired
without one: `C_MountJournal.GetNumMounts` exists, but Blizzard's own journal calls it and
then counts collected mounts by walking the ids anyway, which leaves what it returns genuinely
ambiguous. A guessed counter is worse than none — it would either provoke a walk every login
or suppress one that was needed.

Mounts do without, because they can afford to: the whole mount walk is about 1,900 calls.

## Seeing what it knows, and asking for a fresh one

The mechanism above runs in silence, which was fine while nobody could act on it and is not fine
now that somebody can. Two things break that silence, and the second is also the escape hatch the
argument above always implied.

### `/chronie census`

One line per domain: whether the reading is whole, how many entries it holds, what the client's own
counter said beside it, which build and which character it was walked on, and how long ago.
`apps/addon/src/CensusReport.lua` is the whole of it and `ns.formatAge` is the last field.

**`held` and `counted` on the same line is the point of the line.** They are the two numbers the
audit compares, and putting them side by side turns the guild-achievement question above — does
`GetNumCompletedAchievements` include them? — from something needing `/dump` into something a
person answers by looking.

The line opens with one of four standings, because `complete` alone cannot tell the three ways of
not being complete apart and they mean different things: **never walked** is waiting for a walk,
**cut short** is waiting for the rest of one, and **part of an answer** is a `partial` domain that
will never be whole however long it is left.

### And the same thing in the segments window, while it is happening

A command answers a question somebody thought to ask. The failure this is for is the one where
they did not: the census ran in complete silence, so a client that felt slightly worse for a
minute after every zone gave a player nothing whatever to point at, and the thing they reached for
was the switch.

`ns.newCensusReport.section` is the same reading as a block of `/chronie segments`, under the
totals and over the days — a row per domain saying what it claims, what it holds, what the client
counts and how long ago, with a bar on the one being walked and a heading naming which domain of
how many the pass is on. `Census.lua` reports after every slice and `Main.lua` throttles that to
once a second, and to nothing at all when the window is closed: a repaint rebuilds every row of a
window that may be holding a week of segments, so painting per slice would cost more than the walk
it was drawing.

### Two families, and only one of them is behind a switch

Everything above is about *when* a pass should be provoked. What it does not settle is whether the
addon should be the one asking — and the answer turns out to be different for the two kinds of
thing a census covers, which is why `CensusDomain.group` exists.

**`holdings` is the wallet and the standings**, and they are walked whatever any switch says.
Three reasons, and the third is the one that was learned the hard way.

They are what the app is *drawn from*. A character's currencies and its reputations are on the
Characters screen and in every rollup `collector::holdings` produces; the account's mounts and
achievements are one screen that a reader opens on purpose.

They **complete a sweep that already runs unasked**. `HoldingsSweep` walks the same two panes at
every loading screen and again at logout, with nobody's permission, and does it blind to a
collapsed currency group and to every legacy reputation. The census reaching the rest of the same
question is not a new imposition, it is the other half of one already being paid for.

And they are **character-scoped**, which nothing else here except titles is. An account domain is
answered the same by whoever is logged in, so a walk deferred is a walk somebody else does later;
an alt that is never played is an alt nothing can ever say a wallet or a standing for. They also
cost nine thousand ids against the wardrobe's fifty-five, which is why they go first in the queue.

**`collections` is everything else** — mounts, pets, toys, heirlooms, titles, appearances,
achievements — and that is what `settings.sync.census` gates. It ships `true`.

It shipped `false` for a while, and the switch was the wrong lever: what was wrong was the walk,
and "Cost, and why the player never notices" below is the account of what it now does instead. The
switch stayed because the collections really are the expensive end and somebody should be able to
say no to them.

**One switch over both families was the defect.** Turning off a wardrobe walk nobody could afford
also stopped every currency and reputation the app knew about — silently, with no line in the file
and nothing on a screen to say so — and the Characters view went on drawing holdings out of
whatever the reputation pane happened to have been showing. That is the shape of bug two families
make impossible rather than merely unlikely.

**And nothing is removed by the switch either way.** `Census.lua` walks exactly as it always did,
`audit` still decides what a pass would cover, and both routes below still reach every domain — a
walk somebody asked for by name is not the addon running by itself, so neither is gated. The box
is on Settings under **Game and sync**; the desktop app writes the flag into `src/Settings.lua`
with the rest of them, so it takes effect at the next login or `/reload`.

### Asking for a walk

`audit` is deliberately conservative and should stay so, and with the switch off it is not
consulted on a loading screen at all. Either way what neither covers is a reader who simply knows
a reading is stale — the counter has not noticed, the build has not changed, and nothing else
will provoke a thing. There are two ways to say so.

`/chronie census refresh` walks every domain, immediately, from the chat box.

**The Resync button on the Collection screen** is the one somebody will actually find, and it
travels the road `docs/transmog-sets.md` proved: the app writes `src/CensusRequests.lua` into the
installed addon folder, the addon reads it at load, and the answer comes back through
SavedVariables at logout. `censusrequests.rs` is the shape and the file, `collector::census_requests`
is the storage, `ns.newCensusResync` carries it out and `resync.ts` is what the screen says about
it.

Three things about that channel are load-bearing.

**Nothing about it is immediate**, and the affordance says so rather than implying otherwise. A
request is picked up at the next *load* and answered at the next *logout*, because `ChronieDB` is
written once, at teardown. A button that read as "resync now" would be a button people press twice.

**The request is recorded when the walk ends, not when it starts.** A player who logs out thirty
seconds into a minute-long walk has had part of an answer, which the census files as the positive
observations it is; the request stays unanswered, the app goes on writing it, and the next login
walks again. A record written at the start would have marked that half-pass as the resync somebody
explicitly asked for. The cost is a walk nobody can ever finish going round again at every login,
which is the same walk the audit would provoke anyway and which stops the moment one pass
completes.

**A request carries the domains it wants**, and an empty list means all of them. The button sends
an empty list; naming them is what a targeted probe would use, which is the reason this end is
worth building properly at all — the app knows the whole catalogue out of DB2 and the addon does
not, so "check these ids" is a thing only the desktop can decide to ask for.

The resync runs *before* the audit's own pass at each loading screen, on an install where the
audit runs at all. The other order would have the audit's pass in flight when the request arrived,
and `census.run` refuses a second one — so an explicit ask would be silently deferred every time
the audit had anything at all to say.

## What a walk may not do

**Nothing here touches what the player arranged.** No filter is set, no header expanded, no
category selected.

This is not fastidiousness, it is the difference between this and
`apps/addon/src/HoldingsSweep.lua`, which walks the currency and reputation *panes* and
documents the holes that leaves: a currency under a collapsed group, and every legacy
reputation, which the pane hides by default. The calls that would open those up
(`C_CurrencyInfo.ExpandCurrencyList`, `C_Reputation.ExpandAllFactionHeaders`,
`C_Reputation.SetLegacyReputationsShown`) all rearrange something somebody arranged, and doing
that from a logout handler where nothing can be put back is a worse trade than a hole.

The census does not have to make that trade, because it asks about **ids**, and an id has no
idea how the interface is set up. `C_MountJournal.GetMountIDs` hands over every mount in the
game — the *filtered* pair is `GetNumDisplayedMounts`/`GetDisplayedMountID`, which is what
Blizzard's own list is drawn from and what this deliberately is not.

The same escape exists for the two domains `HoldingsSweep` gets wrong, which is why they were
the obvious next adapters: on 12.0.5.67823 the client has
`C_CurrencyInfo.GetCurrencyInfo(id)` and `C_Reputation.GetFactionDataByID(id)`, both of which
answer completely, by id, with no pane involved. **Both have been taken** — see below.

## Currencies, and why the sweep survived them

`currencies` is the first `scope = "character"` domain, and the first one that removes a trade
rather than making one. `GetCurrencyInfo(id)` takes an arbitrary id and hands over the whole
row — the balance, `totalEarned`, `maxQuantity`, `quantityEarnedThisWeek`, `maxWeeklyQuantity`,
`discovered`, `isAccountWide`, `isAccountTransferable` — so the currency under a collapsed group
that the sweep cannot see is simply another id, and the two counts nothing else could answer,
"am I capped" and "have I done my weekly", arrive with it.

**There is no enumerator**, so the positions are a range rather than a list. `C_CurrencyInfo`
has no `GetCurrencyIDs`, no counter, and its one call that hands over ids is keyed by a category
id that only lives in the game's own tables. `CurrencyTypes` on 12.0.5.67823 is 1,490 rows
running from 42 to 3513, read out of the install the same way `currencies.rs` reads it for
icons, so the walk asks about 1 to 5,000 — that top id and half again. An id above the ceiling
would be invisible to a walk that still called itself complete, which is the one hole left here;
it is bounded, and raising the number costs twenty-five slices against the achievement walk's
minute.

**And no counter**, for the same reason there is no enumerator: `GetCurrencyListSize` counts the
rows the pane is drawing, which is the very number this domain exists not to trust. So it is
never distrusted into a pass of its own and is walked when something else provokes one.

**The sweep is not made redundant by it, which is the part worth arguing for.** The census
reading is strictly the better one and would be the obvious thing to fold `character_currencies`
onto — but a census is spread a slice per frame and therefore cannot finish inside a logout
handler, and a logout is exactly where `HoldingsSweep` is read: the freshest reading there will
ever be of a character that is about to stop answering, and the one every other character's
rollup goes on reading until it is played again. So the two are complementary. The sweep stays
live and shallow in `character_currencies`; the census is complete and occasional in
`census_currencies`, qualified by its claim like every other reading here. One table with two
writers of different freshness, and no column saying which of them a row came from, would be
worse than two tables that each say what they are.

**Which leaves somebody having to read both, and for a long time nobody did.** The census tables
were written and then read by nothing at all, so the currencies under a collapsed group and the
legacy reputations — the entire reason these two domains exist — never reached a screen. The join
is a read-model concern and lives in `collector::holdings::account_holdings`: the two tables are
unioned per character and per id, and the later `at` wins outright rather than being merged field
by field, because each row is one reading of one wallet at one moment and half of an old one
beside half of a new one is a balance nobody ever held. A tie falls to the census, being the
deeper of the two. Both are keyed on `character_id`, so the only pair that ever competes is a
sweep and a walk by the *same* character — two alts' wallets are two wallets and are summed like
anything else.

## Reputations, and the hole nothing else could reach

`reputations` is the second `scope = "character"` domain, and the one that closes the largest
hole in the whole record. `HoldingsSweep` walks the reputation pane, and **the pane hides every
legacy reputation unless the player has asked for them** — which is most of the game's factions.
The call that would show them, `C_Reputation.SetLegacyReputationsShown`, rearranges a pane
somebody arranged. `GetFactionDataByID(id)` does not: it answers for a faction whether the pane
is drawing it, hiding it, or has it folded under a collapsed expansion header.

The positions are a range, for the same reason currencies' are. `C_Reputation` enumerates the
pane and nothing else — `GetNumFactions` counts the rows it is drawing, which is the very number
this domain exists not to trust, so it is also not a counter this domain can be distrusted by.
`Faction` on 12.0.5.67823 is 860 rows running from 1 to 2793, so the walk asks about 1 to 4,000:
that top id and half again, twenty slices, the same bounded hole with the same free fix.

**The reduction is `ns.readFactionStanding`'s, reused rather than reimplemented.** Four systems
answer "where does this character stand" and none of them share a shape — renown, paragon,
friendship, and the classic reaction ladder — and that function is what turns any of them into
one bar with a `rank` and the `system` the rank was read off. Without it two characters'
standings with the same faction cannot be compared at all, because "Renown 12" and "Honored" do
not sort.

`isAccountWide` rides along, and belongs exactly where `account_wide` sits for a currency: a
warband reputation is one standing every character on the account reports, and treating it as a
standing each is the mistake the warband gold pot exists to avoid.

### The id is the point, and it is also the defect it fixes

`character_standings.faction` used to be a **localised name**, and so was the key the addon
filed a standing under. A player who switched the client's language came back as a second
character standing with a second faction, and the account's best was decided between two halves
of one grind. Worse, the desktop had to *enter* the game's tables through `Faction`'s name
column to find out anything else about a faction — matching case-insensitively on a trimmed
string and following every one of the fourteen names that sit on more than one `Faction` row —
which is what `reputations.rs` opened with and no longer does.

So the migration takes `character_standings` onto `faction_id`, and the rows do not come with
it: a name is not an id and nothing in the collector could turn one into the other. They are
re-derived wholesale from the addon's snapshot at the next sync, which is what that table has
always been.

## What is written down, and what is not

**Only what is held.** The catalogue of everything that *exists* lives in the game's own
tables, which the desktop already reads — `Achievement` is 13,732 rows in `achievements.rs`,
`ItemAppearance` is 55,198 in `wardrobe.rs`. A census that also recorded every absence would
be several times the size and would say nothing the desktop could not work out by subtraction.

The one thing carried beyond the id is a localised name, because the addon has it free and a
machine with no game installed still has to be able to draw the list. That is the same bargain
`character_looks` makes.

## Achievements, and why they pay for the whole mechanism

`GetAchievementInfo` reports `completed` for the **account** and `wasEarnedByMe` for whoever
is asking, and hands over `earnedBy` — the name of the alt that actually did it — beside them.

So one character, in one pass, reports the entire account's achievement history *and*
attributes each line of it. Nothing has to be unioned across the roster and nothing waits for
an alt to be logged in. No other domain answers a question that cleanly, and it is the reason
achievements were one of the two the mechanism was proven on.

The walk is by category, because there is no id list: `GetCategoryList` names the trees,
`GetCategoryNumAchievements` says how deep each is, and `GetAchievementInfo(category, index)`
returns the whole row, id included. So the plan is drawn with about eighty calls and a
position then costs one call rather than two — 13,700 reads instead of 27,400.

## Cost, and why the player never notices

**This section used to describe a walk a player switched the census off to be rid of**, and the
five things wrong with it are worth keeping written down, because each is a plausible-looking
decision that turns out to be a tax on every evening.

**A slice ran every frame.** `C_Timer.After(0, …)` is "next frame", and the reasoning for it was
that the budget below already bounded the work — so the pass would be over quickly. What it
actually asked for was a share of *every* frame for as long as the pass lasted. It is now
`SLICE_DELAY`, a twentieth of a second, which is a duty cycle of a few per cent rather than a
claim on all of them.

**A slice was bounded by a count.** Two hundred positions was chosen against the mount journal,
where a position is one cheap call. A reputation is up to four calls, one of which reaches the
major-faction and friendship tables; an appearance is a table index behind a call already made.
A count can only ever be right for the domain it was picked against. The bound is now
`SLICE_MILLISECONDS` — a tenth of a frame at sixty, read off `debugprofilestop` every
`CLOCK_EVERY` positions — with the count kept as a ceiling over it for a client that has no such
clock.

**Nothing waited out a fight.** A slice landing during a pull is the same slice as any other and
is the only one anybody will ever notice. `deps.busy` is `InCombatLockdown`, and a busy moment is
waited out rather than worked through: nothing is lost, because the queue, the plan and everything
already observed are all still there when it ends.

**The plan was drawn inside one frame.** `list` was allowed to be "arithmetic and a handful of
calls", and it was — but it also built an entry per position: three arrays of up to fifty-five
thousand for the wardrobe, in the single frame the whole slicing mechanism exists to protect. A
domain whose positions are an unbroken run now returns an integer and the walk counts, and the two
domains that walk a plan hold it as about eighty boundaries with a binary search over them.

**And the big one: the wardrobe was re-walked at every loading screen.** `audit` runs on the far
side of each of them, and two of its answers never settle — a `partial` domain is never complete
by construction, and a counter that disagrees for a reason of the client's own goes on
disagreeing. So both were named *every time*, and a player zoning in and out of a dungeon paid for
a full pass on each. This document said a partial domain was walked once a session; nothing
enforced it. A finished pass now buys quiet: `DEFAULT_QUIET` of a quarter of an hour, an hour for
a partial domain, keyed on the persisted `completedAt` so logging in and out does not reset it —
and asked *after* who did the walking, so the mage's pass ten minutes ago is no reason at all to
refuse the paladin, which is what keeps the union across the roster happening. A build that has
changed goes through the quiet whatever the clock says, because that is not a stale reading but a
reading of a different game.

The whole of a census is now a couple of seconds of client work spread over about half a minute of
wall clock at a few per cent of a frame.

It still starts ten seconds after the world arrives, which is not politeness: the achievement tree
is sent by the server *after* login, and a walk that began before it landed would find nothing and
then claim, in writing, that the account had earned nothing.

Ten seconds makes that unlikely rather than impossible, so it is not the only defence. **A
walk that ends having observed nothing at all, against a reading that held something, is
refused the completeness claim**: it leaves the entries alone, leaves the flag down, and does
not bump the revision, which makes it exactly the interrupted pass the rule above already
handles safely — and which it very probably is. An account that holds nothing and has always
held nothing is untouched, because there is no reading to protect. The cost of being wrong
that way is one census walked again; the cost of believing a client that had not been told
anything yet would be an account's entire achievement history deleted by one unlucky login.

Payload is not a constraint at these sizes. A shipping `RareScanner.lua` on a real install is
2.8 MB; an established account's whole achievement census is a fraction of that.

What *is* a constraint is that `ChronieDB` is written once, at logout, wholesale from memory —
see `docs/saved-variables.md`. A census is therefore not a stream but a claim made at
teardown, which is precisely why the completeness flag has to travel in the file rather than
be inferred from it.

## Appearances, and the domain that is only ever part of an answer

`appearances` is the largest thing the census lights up and the first domain that **can never be
whole**. `wardrobe.rs` reads all 55,198 appearances of a shipping install out of `ItemAppearance`
and `transmog.rs` reads the sets that name them; until this domain neither knew whether the reader
owned any of it, and a look ten years in the wardrobe was drawn exactly like one nobody had ever
seen.

`C_TransmogCollection.GetCategoryAppearances(category [, transmogLocation])` is what closes it —
the second argument is optional, which the 12.0.5.67823 client's own usage string says outright,
so there is no transmog location to build and no slot of the player's to name. One call per
category answers for every appearance in it with its `visualID` and its `isCollected`, which is
about thirty calls against a walk of fifty-five thousand. The categories are
`Enum.TransmogCollectionType`, 1 to 29 on that build, and there is no enumerator for them either —
so the walk asks `GetCategoryInfo` about 1 to 40 and skips what does not answer.

**The client shows the wardrobe through the logged-in character's class filter.** A mage is not
shown plate, however faithfully the walk runs to the end. Issue #250 settled which way out to take:
the account's wardrobe is the *union* of what its characters can each see, built up as they are
played — rather than something one character forces by driving `SetClassFilter` over all thirteen
classes, which is complete in a single login and leaves the player's own wardrobe filtered to
somebody else's class if the session ends mid-walk. If that second way is ever wanted it should be
an explicit, user-initiated resync rather than something that happens at a loading screen.

So the domain declares `partial`, and three things follow from it:

- **It never claims completeness and is never pruned.** That is the standing an interrupted pass
  already has, and it is the "character that can only see part of what the account owns" case the
  rule at the top of this document was written for. `census_domains.complete` for this domain is 0
  permanently, and nothing in `collector::census` may delete one of its rows.
- **It is never settled by an audit, so what decides when it is walked again is the clock.** Every
  other domain here is also fed by a client event between passes; this one is not, and the
  character in front of the client is a different part of the answer every time. That is what
  `PARTIAL_QUIET` is for — an hour between passes by the same character, and none at all against a
  different one, which is what lets a paladin's login add the plate a mage's could not see. Before
  it there was no interval and this domain was re-walked at every loading screen, which is the
  single largest thing that was wrong with the census.
- **No filter of the player's can make it wrong.** Whether `GetCategoryAppearances` applies the
  collected, source-type and faction filters in the client or leaves them to Lua could not be
  settled from the install — Blizzard's own `WardrobeItemsCollectionMixin:FilterVisuals` on
  12.0.5.67823 filters `isHideVisual` and no more, which points the other way from what the call's
  name suggests. It does not matter. Every one of those filters can only make the returned list
  *smaller*, a smaller list is a smaller set of positive observations, and a reading that never
  claims completeness can never delete anything on the strength of one. Nothing reads a filter and,
  as everywhere else here, nothing writes one.

`GetCategoryCollectedCount(category)` is the counter, and it is the unfiltered one — the client
keeps a `GetFilteredCategoryCollectedCount` beside it, which is what Blizzard's own progress bar
under the wardrobe grid draws. Summed over the categories it is the client's own opinion of how
much of this the account has, against which `held` is how much of it the roster has managed to show
us. That difference is the one honest measure of how far the union has got, and
`collected.ts::collectedNote` is what turns it into the sentence the browsers carry: an unmarked
row reads as "not collected", and on this reading that is wrong for every look nobody has logged in
to find yet.

There is no localised name, and this is the one domain that cannot carry one. The client's
appearance list is ids and flags, and what a look is *called* is the name of one of however many
items give it — `wardrobe.rs`'s decision, out of the game's own tables, and not one an addon is in
a position to make. What rides along instead is the category, which is enough for a machine with no
install to count a reader's heads.

## Pets, toys, heirlooms and titles: the long tail

Four domains of the same shape, and none of them a day's work on its own — but between them they
are most of what is left of a collection, and each one turns out to say something the three big
domains did not have to answer.

### Pets are counted in species, and that is what makes them odd

`C_PetJournal.GetOwnedPetIDs()` hands over one GUID per **pet**, and a collection is counted in
**species**: three Mechanical Squirrels are three GUIDs and one line of the pet journal. So the id
an entry is filed under is the species, which is also the only thing it could be — a pet's GUID is
a string like `BattlePet-0-000008B1F3A1`, and every census id is a number.

`count` is the client's own `GetNumCollectedInfo(speciesID)` rather than a tally of the walk, and
the difference shows in exactly the case this design is built around: a pass a logout cut short
still says how many of a species the account has instead of how many of them it got as far as. It
is also the number the `NEW_PET_ADDED` handler in `Main.lua` already asks for, so the two halves of
the record agree by construction.

The level and the nickname are the **best of them** — the highest-levelled pet of the species, the
one somebody would actually summon. A species is the unit, so a level has to be some pet's, and the
highest is the only choice that does not depend on the order the client handed the GUIDs over in.

**And no counter, because the free one counts the wrong thing.** `#GetOwnedPetIDs()` costs nothing
and counts pets, while `held` counts species — so on any account that kept a duplicate of anything
it would sit permanently above what is written down and provoke a full pass at every login, for
ever. A counter counting a different set from the one stored is the guessed counter this document
already argues is worse than none.

Pets are also the one collection here that can **shrink**: a pet can be caged away or released, so
a complete walk prunes like a mount walk does.

### Toys and heirlooms are partial, because the client's list may be the player's

The other two are grow-only, and both are marked `partial` for the same unsettled reason.

`C_ToyBox` has exactly one indexer, `GetToyFromIndex(itemIndex)`, and Blizzard's own
`blizzard_toybox.lua` on 12.0.5.67823 pairs it with `GetNumFilteredToys` in both places it uses it —
`ToySpellButton_UpdateButton` and `ToyBox_FindPageForToyID`. So the list the walk indexes into is
very probably the one the player's filters left standing. `C_Heirloom.GetHeirloomItemIDs` is the
mirror image: nothing in Blizzard's whole interface calls it, so nothing in the install says
whether it answers past the heirloom pane's class, spec and source filters. Naming is the only
evidence there, and the toy box next door is a live counter-example to naming as evidence.

The walk is unaffected either way — no filter is read and none is written, `PlayerHasToy(itemID)`
and `C_Heirloom.PlayerHasHeirloom(itemID)` answer about an id whatever a pane is showing — so the
only thing at stake is the **claim**. Being wrong towards completeness would prune away every toy
the player had filtered out of view; being wrong towards `partial` costs a walk a session and one
prune that could never have been right anyway, because **neither collection can shrink**. That
asymmetry is the whole argument, and it is why `partial` is the right reach here where the general
advice in *Adding a domain* is to be sparing with it.

**What would settle either** is a running client and one comparison. For toys: with a restrictive
filter set in the toy box, `C_ToyBox.GetNumToys()` against `C_ToyBox.GetNumFilteredToys()` and what
`GetToyFromIndex` walks out. For heirlooms: with a class filter set in the heirloom pane,
`#C_Heirloom.GetHeirloomItemIDs()` against `GetNumHeirlooms()` and `GetNumDisplayedHeirlooms()`.
Lifting `partial` afterwards is one line in each domain.

`GetNumKnownHeirlooms()` rides along as the heirloom counter even so. It settles nothing — a
partial domain is never audited — but it is the client's own opinion of how many the account has,
and beside `held` it is what says how much of the answer a walk reached: the same pair appearances
keep. Toys get none, because `GetNumLearnedDisplayedToys` is filter-dependent by its own name and
would fall *below* `held` the moment somebody narrowed the pane.

An heirloom carries how far it has been taken and how far it goes, which is its version of a
currency's cap: "is this one finished with" is a question no amount of watching somebody buy an
upgrade would answer for the ones bought years before Chronie existed.

### Titles are one character's, and the space in them means something

`titles` is the third `scope = "character"` domain and the plainest of them — two alts of one
account share almost no titles — so a walk by one prunes that character's rows and nobody else's.

There is no pane and no filter anywhere near it. `GetNumTitles()` is the top of the title mask
range rather than a count of anything held, `IsTitleKnown(i)` answers for a mask id, and most of
the range is not a title this character has. That is exactly what Blizzard's own
`PaperDollTitlesPane_Update` walks, and the census walks it the same way — **including the
`playerTitle` return**, which that pane requires before it will draw a row. A mask the client knows
but does not call a player title is not a title anybody can wear, and a list carrying one would
disagree with the pane the player is looking at.

The name is stored **trimmed**, as `TitleUtil.GetNameFromTitleMaskID` trims it for display — the
client hands these over already spaced for the player's name, `"Sergeant "` before it and
`" the Explorer"` after. Trimming alone would throw away the one thing the spacing said, so which
side it goes on is kept as a flag rather than as a space nothing downstream would think to
preserve.

**No counter**: nothing in the client counts known titles, and `GetNumTitles` is the size of the
range, which would sit an order of magnitude above `held` and provoke a pass at every login.

### What is not here

Nothing draws these yet. The Collection screen is the *subtraction* — what the account has not got
— and that half needs the game's own tables, which means `BattlePetSpecies`, `Toy`, `Heirloom` and
`CharTitles` registered in `docs/game-tables.json` and a catalogue reader each, the way
`achievements::catalogue` and `mounts::catalogue` are. This is the census half: the four readings,
their claims, and the tables to keep them in.

## Adding a domain

A domain is a name, a scope, and three seams:

```lua
{
    name = "toys",
    scope = "account",
    list = function() ... end,   -- positions to visit; nil when this build cannot answer
    read = function(position) ... end,  -- returns id, entry — or nothing for a thing not held
    count = function() ... end,  -- the cheap audit, or nil when the client offers none
    partial = true,              -- optional: a walk of this is only ever part of the answer
}
```

`list` must be arithmetic and a handful of calls — never the walk itself, which is what the
per-frame budget exists to spread out. Where the client hands over ids outright a position
*is* an id; where it does not, a position is an index into a plan the domain drew up, which is
how the achievement tree is walked, or simply a range, which is how currencies are.

A `partial = true` domain is one no single walk can finish, because the client only answers about
the part of it the walking character can see — see appearances above. It is never pruned, never
claims completeness, and is never settled by an audit, which is what makes the union across the
roster happen at all. Reach for it only when the incompleteness is in the client's answer rather
than in the walk: an interrupted pass is already handled, and a domain that could be whole and
says it cannot be would be one nothing downstream is ever allowed to subtract from.

A `scope = "character"` domain is kept per `Name-Realm` all the way down: the addon files it
under `census.characters[key]`, the collector resolves that key to a character and stores the
entries against it, and a complete reading prunes **that character's rows and no others** — a
walk by one alt says what that alt holds and nothing whatever about the rest of the roster.

Then a table and a reader in `collector::census`. Nothing in `Census.lua` changes, and nothing
downstream of the claim does either — `census_domains` is the same shape for every kind of
thing, which is the whole point of keeping it apart from the per-domain tables.

## What the app draws with it

The mechanism is only worth what it shows, and what it shows is on the **Collection** screen:
`apps/desktop/src/collectionView.tsx` draws it and `collection.ts` holds the rules.

**The interesting half is not the list.** A list of what an account holds is a thing the game
already has a pane for, and the addon could have written it into a tooltip. What no in-game
addon can do is the *subtraction* — because the names of the things somebody has not got are in
the client's own DB2 tables and an addon cannot read those. `achievements::catalogue` hands over
all 13,732 rows of `Achievement` with their categories, points and icons, `mounts::catalogue`
hands over `Mount`, and the screen is what is left when the census is taken away from them: what
is missing in a category ranked by points, which character has been carrying the account, and a
genuine timeline out of `earned_year`/`earned_month`/`earned_day` that reaches back years before
Chronie was installed.

**And the rule travels with it.** Every number on that screen is a subtraction made against one
of these readings, and a reading that did not finish licenses none — so the claim is drawn
*before* the numbers rather than as a footnote under them, and `collection.ts::caveat` is what
decides which of three things the screen is allowed to say:

| What the reading is | What may be said |
|---|---|
| no completed pass, ever | not a count of what the account holds — a count of what Chronie watched it collect |
| a pass that was cut short | at least this much, and what is left is an upper bound |
| a pass that finished | the subtraction, qualified only by the rows the install could not read |

That last qualification is the catalogue's rather than the census's, and it is kept for the same
reason: a total with a silent hole in it is the one number on the screen a reader has no way of
checking. Both catalogues count the rows their table declared and could not decrypt, and the
screen says so.

Two commands rather than one, because the halves fail apart. `account_census` is Chronie's own
database and answers in a millisecond on a machine with no game installed — which is what the
localised name the addon writes beside every id is for. `collection_catalogue` is the game's
storage, costs what the transmog sets cost, and is simply absent without an install; when it
fails the lists still draw and the totals say `—`.
