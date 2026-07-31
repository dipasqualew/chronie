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
answer completely, by id, with no pane involved. **Currencies have been taken** — see below.
Faction ids are still to come, and would also take `character_standings` off localised names,
which is what `reputations.rs` currently has to join on.

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

A walk is spread a slice per frame through `C_Timer.After`, 200 ids at a time. It starts ten
seconds after the world arrives, which is not politeness: the achievement tree is sent by the
server *after* login, and a walk that began before it landed would find nothing and then
claim, in writing, that the account had earned nothing.

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

## Adding a domain

A domain is a name, a scope, and three seams:

```lua
{
    name = "toys",
    scope = "account",
    list = function() ... end,   -- positions to visit; nil when this build cannot answer
    read = function(position) ... end,  -- returns id, entry — or nothing for a thing not held
    count = function() ... end,  -- the cheap audit, or nil when the client offers none
}
```

`list` must be arithmetic and a handful of calls — never the walk itself, which is what the
per-frame budget exists to spread out. Where the client hands over ids outright a position
*is* an id; where it does not, a position is an index into a plan the domain drew up, which is
how the achievement tree is walked, or simply a range, which is how currencies are.

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
