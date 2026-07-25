#!/usr/bin/env python3
"""Tests for the session collector. Run with `python3 -m unittest discover scripts`,
or through scripts/check.sh, which runs them alongside luacheck and busted."""

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import collect  # noqa: E402

TEMPLATE = Path(__file__).resolve().parent.parent / "web" / "report.template.html"

SAVED_VARIABLES = """
WdpWowDB = {
\t["roster"] = {
\t\t["Thrall-Ragnaros"] = {
\t\t\t["classFile"] = "WARRIOR",
\t\t\t["level"] = 80,
\t\t},
\t},
\t["sessions"] = {
\t\t{
\t\t\t["id"] = "Thrall-Ragnaros|100|Ulduar",
\t\t\t["character"] = "Thrall-Ragnaros",
\t\t\t["classFile"] = "WARRIOR",
\t\t\t["day"] = "2026-07-25",
\t\t\t["instance"] = "Ulduar",
\t\t\t["difficulty"] = "25 Player",
\t\t\t["instanceType"] = "raid",
\t\t\t["difficultyId"] = 4,
\t\t\t["startedAt"] = 100,
\t\t\t["endedAt"] = %(ended)d,
\t\t\t["seconds"] = 1800,
\t\t\t["lootValue"] = 2000,
\t\t\t["goldDiff"] = 1500,
\t\t\t["transmogs"] = {
\t\t\t\t{ ["id"] = 19019, ["at"] = 150 },
\t\t\t},
\t\t\t["currencyTotal"] = 15,
\t\t\t["reputationTotal"] = 40,
\t\t\t["currencies"] = {
\t\t\t\t{
\t\t\t\t\t["id"] = 1166,
\t\t\t\t\t["name"] = "Timewarped Badge",
\t\t\t\t\t["amount"] = 15,
\t\t\t\t}, -- [1]
\t\t\t},
\t\t\t["reputation"] = {
\t\t\t\t{
\t\t\t\t\t["faction"] = "Argent Dawn",
\t\t\t\t\t["amount"] = 40,
\t\t\t\t}, -- [1]
\t\t\t},
\t\t\t["achievements"] = {
\t\t\t\t{
\t\t\t\t\t["id"] = 1234,
\t\t\t\t\t["name"] = "The Loremaster",
\t\t\t\t\t["at"] = 150,
\t\t\t\t}, -- [1]
\t\t\t},
\t\t}, -- [1]
\t},
}
"""


def saved_variables(ended: int) -> str:
    return SAVED_VARIABLES % {"ended": ended}


class LuaReaderTest(unittest.TestCase):
    def read(self, text):
        return collect.LuaReader(text).read_value()

    def test_reads_a_string_keyed_table(self):
        self.assertEqual(self.read('{ ["a"] = "x", ["b"] = "y" }'), {"a": "x", "b": "y"})

    def test_reads_a_bare_name_key(self):
        self.assertEqual(self.read("{ name = 1 }"), {"name": 1})

    def test_collapses_a_1_to_n_table_into_a_list(self):
        self.assertEqual(self.read('{ "a", "b", "c" }'), ["a", "b", "c"])

    def test_keeps_a_sparse_numeric_table_as_a_mapping(self):
        self.assertEqual(self.read("{ [1] = 10, [3] = 30 }"), {"1": 10, "3": 30})

    def test_reads_nested_tables(self):
        self.assertEqual(self.read('{ ["a"] = { ["b"] = { 1, 2 } } }'), {"a": {"b": [1, 2]}})

    def test_reads_numbers_of_every_shape(self):
        self.assertEqual(self.read("{ -3, 2.5, 1e3, -0.5, 0x10 }"), [-3, 2.5, 1000.0, -0.5, 16])

    def test_reads_booleans_and_nil(self):
        self.assertEqual(self.read('{ ["t"] = true, ["f"] = false, ["n"] = nil }'), {"t": True, "f": False, "n": None})

    def test_ignores_the_index_comments_the_client_appends(self):
        self.assertEqual(self.read('{\n"a", -- [1]\n"b", -- [2]\n}'), ["a", "b"])

    def test_ignores_a_long_comment(self):
        self.assertEqual(self.read('{ --[[ skip me ]] "a" }'), ["a"])

    def test_unescapes_string_escapes(self):
        self.assertEqual(self.read(r'{ "a\"b\nc\\d" }'), ['a"b\nc\\d'])

    def test_reads_a_decimal_escape(self):
        self.assertEqual(self.read(r'{ "\65\66" }'), ["AB"])

    def test_survives_a_colour_coded_name(self):
        self.assertEqual(self.read(r'{ ["n"] = "|cffc79c6eThrall|r" }'), {"n": "|cffc79c6eThrall|r"})

    def test_rejects_an_unterminated_table(self):
        with self.assertRaises(collect.LuaSyntaxError):
            self.read('{ ["a"] = 1')

    def test_rejects_an_unterminated_string(self):
        with self.assertRaises(collect.LuaSyntaxError):
            self.read('{ ["a"] = "oops }')

    def test_reports_the_line_a_problem_is_on(self):
        with self.assertRaisesRegex(collect.LuaSyntaxError, "line 3"):
            self.read('{\n"a",\nnonsense nonsense')


class SavedVariablesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "wdp-wow.lua"

    def test_returns_the_named_global(self):
        self.path.write_text(saved_variables(500), encoding="utf-8")

        saved = collect.read_saved_variables(self.path)

        self.assertEqual(saved["sessions"][0]["instance"], "Ulduar")
        self.assertEqual(saved["roster"]["Thrall-Ragnaros"]["level"], 80)

    def test_skips_globals_it_was_not_asked_for(self):
        self.path.write_text('Other = { 1, 2 }\nWdpWowDB = { ["sessions"] = { } }\n', encoding="utf-8")

        self.assertEqual(collect.read_saved_variables(self.path), {"sessions": []})

    def test_returns_none_when_the_variable_is_absent(self):
        self.path.write_text("Other = { 1 }\n", encoding="utf-8")

        self.assertIsNone(collect.read_saved_variables(self.path))


class NormaliseTest(unittest.TestCase):
    def record(self, **overrides):
        base = {
            "id": "a", "character": "Thrall-Ragnaros", "endedAt": 200, "startedAt": 100,
            "instance": "Ulduar", "lootValue": 2000, "goldDiff": 1500,
            "reputation": [{"faction": "Argent Dawn", "amount": 40}],
            "currencies": [{"id": 1166, "name": "Timewarped Badge", "amount": 15}],
            "achievements": [{"id": 1234, "name": "The Loremaster", "at": 150}],
            "transmogs": [{"id": 19019, "at": 175}],
            "quests": [{"id": 7848, "at": 180}],
        }
        base.update(overrides)
        return base

    def test_fills_in_every_field_the_report_reads(self):
        cleaned = collect.normalise(self.record())

        self.assertEqual(cleaned["seconds"], 100)
        self.assertEqual(cleaned["difficulty"], "")
        self.assertEqual(cleaned["transmogs"], [{"id": 19019, "at": 175}])
        self.assertIsNone(cleaned["classFile"])
        self.assertEqual(cleaned["lootValue"], 2000)
        self.assertEqual(cleaned["goldDiff"], 1500)
        self.assertEqual(cleaned["reputation"], [{"faction": "Argent Dawn", "amount": 40}])
        self.assertEqual(cleaned["currencies"], [{"id": 1166, "name": "Timewarped Badge", "amount": 15}])
        self.assertEqual(cleaned["achievements"], [{"id": 1234, "name": "The Loremaster", "at": 150}])
        self.assertEqual(cleaned["quests"], [{"id": 7848, "at": 180}])

    def test_defaults_the_new_totals_to_zero_when_absent(self):
        cleaned = collect.normalise({"id": "a", "character": "Thrall-Ragnaros", "endedAt": 200})

        self.assertEqual(cleaned["lootValue"], 0)
        self.assertEqual(cleaned["goldDiff"], 0)
        self.assertEqual(cleaned["currencies"], [])
        self.assertEqual(cleaned["achievements"], [])
        self.assertEqual(cleaned["quests"], [])

    def test_drops_a_record_with_no_identity(self):
        self.assertIsNone(collect.normalise(self.record(id=None)))
        self.assertIsNone(collect.normalise(self.record(character="")))
        self.assertIsNone(collect.normalise(self.record(endedAt=None)))
        self.assertIsNone(collect.normalise("not a table"))

    def test_drops_a_reputation_entry_with_no_faction(self):
        cleaned = collect.normalise(self.record(reputation=[{"amount": 5}, "junk"]))

        self.assertEqual(cleaned["reputation"], [])

    def test_drops_a_currency_entry_with_no_name(self):
        cleaned = collect.normalise(self.record(currencies=[{"id": 1, "amount": 5}, "junk"]))

        self.assertEqual(cleaned["currencies"], [])

    def test_drops_an_achievement_entry_with_no_name(self):
        cleaned = collect.normalise(self.record(achievements=[{"id": 1, "at": 5}, "junk"]))

        self.assertEqual(cleaned["achievements"], [])

    def test_drops_a_quest_entry_with_no_id(self):
        cleaned = collect.normalise(self.record(quests=[{"at": 5}, "junk"]))

        self.assertEqual(cleaned["quests"], [])

    def test_dates_a_record_the_addon_never_dated(self):
        cleaned = collect.normalise(self.record(day=None))

        self.assertRegex(cleaned["day"], r"^\d{4}-\d{2}-\d{2}$")


class MergeTest(unittest.TestCase):
    def record(self, identity, ended, **overrides):
        base = {"id": identity, "character": "Thrall-Ragnaros", "endedAt": ended, "gold": 1}
        base.update(overrides)
        return base

    def test_adds_records_it_has_not_seen(self):
        database = {"sessions": []}

        added, dropped = collect.merge(database, [self.record("a", 100), self.record("b", 200)], 7, 300)

        self.assertEqual((added, dropped), (2, 0))
        self.assertEqual(len(database["sessions"]), 2)

    def test_replaces_a_record_it_already_holds(self):
        database = {"sessions": [self.record("a", 100, gold=1)]}

        added, _ = collect.merge(database, [self.record("a", 100, gold=99)], 7, 300)

        self.assertEqual(added, 0)
        self.assertEqual(database["sessions"][0]["gold"], 99)

    def test_drops_records_older_than_the_window(self):
        now = 1_000_000
        database = {"sessions": [self.record("old", now - 8 * collect.DAY_SECONDS)]}

        _, dropped = collect.merge(database, [self.record("new", now)], 7, now)

        self.assertEqual(dropped, 1)
        self.assertEqual([record["id"] for record in database["sessions"]], ["new"])

    def test_orders_newest_first(self):
        database = {"sessions": []}

        collect.merge(database, [self.record("a", 100), self.record("c", 300), self.record("b", 200)], 7, 300)

        self.assertEqual([record["id"] for record in database["sessions"]], ["c", "b", "a"])


class RenderTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.out = Path(self.dir.name) / "report.html"

    def test_injects_the_payload_into_the_template(self):
        database = {"sessions": [{"id": "a", "instance": "Ulduar", "endedAt": 1}]}

        collect.render(database, TEMPLATE, self.out, 7)
        html = self.out.read_text(encoding="utf-8")

        self.assertNotIn("/*__WDP_DATA__*/null", html)
        self.assertIn('"instance": "Ulduar"', html.replace('"instance":"Ulduar"', '"instance": "Ulduar"'))
        self.assertIn('"retainDays"', html)

    # A faction or instance name is player-visible text; a stray "</script>" in one
    # would otherwise end the block and break the page.
    def test_cannot_be_broken_out_of_by_the_data(self):
        database = {"sessions": [{"id": "a", "instance": "</script><b>x", "endedAt": 1}]}

        collect.render(database, TEMPLATE, self.out, 7)

        self.assertNotIn("</script><b>", self.out.read_text(encoding="utf-8"))

    def test_refuses_a_template_without_the_placeholder(self):
        template = Path(self.dir.name) / "bare.html"
        template.write_text("<html></html>", encoding="utf-8")

        with self.assertRaises(SystemExit):
            collect.render({"sessions": []}, template, self.out, 7)


class EndToEndTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.root = Path(self.dir.name)
        self.wow = self.root / "_retail_"
        self.saved = self.wow / "WTF" / "Account" / "12345#1" / "SavedVariables"
        self.saved.mkdir(parents=True)
        self.out = self.root / "out"

    def write(self, ended):
        (self.saved / "wdp-wow.lua").write_text(saved_variables(ended), encoding="utf-8")

    def run_collect(self, *extra):
        return collect.main(["--wow-path", str(self.wow), "--out", str(self.out), *extra])

    def test_writes_a_database_and_a_report(self):
        self.write(int(time.time()))

        self.assertEqual(self.run_collect(), 0)

        database = json.loads((self.out / "sessions.json").read_text(encoding="utf-8"))
        self.assertEqual(len(database["sessions"]), 1)
        self.assertEqual(database["sessions"][0]["instance"], "Ulduar")
        self.assertTrue((self.out / "report.html").exists())

    def test_collecting_twice_does_not_duplicate_a_session(self):
        self.write(int(time.time()))

        self.run_collect()
        self.run_collect()

        database = json.loads((self.out / "sessions.json").read_text(encoding="utf-8"))
        self.assertEqual(len(database["sessions"]), 1)

    def test_forgets_a_session_older_than_the_window(self):
        self.write(int(time.time()) - 8 * collect.DAY_SECONDS)

        self.run_collect()

        database = json.loads((self.out / "sessions.json").read_text(encoding="utf-8"))
        self.assertEqual(database["sessions"], [])

    def test_survives_an_account_file_it_cannot_parse(self):
        (self.saved / "wdp-wow.lua").write_text("WdpWowDB = { broken", encoding="utf-8")

        self.assertEqual(self.run_collect(), 0)
        self.assertTrue((self.out / "report.html").exists())

    def test_survives_a_database_it_cannot_parse(self):
        self.write(int(time.time()))
        self.out.mkdir(parents=True)
        (self.out / "sessions.json").write_text("{not json", encoding="utf-8")

        self.run_collect()

        database = json.loads((self.out / "sessions.json").read_text(encoding="utf-8"))
        self.assertEqual(len(database["sessions"]), 1)

    def test_reports_a_wow_path_that_is_not_a_wow_folder(self):
        with self.assertRaises(SystemExit):
            collect.main(["--wow-path", str(self.root / "nowhere"), "--out", str(self.out)])


if __name__ == "__main__":
    unittest.main()
