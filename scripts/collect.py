#!/usr/bin/env python3
"""Collect wdp-wow instance sessions out of the game's SavedVariables into a local
database, and render them as a standalone HTML report.

This runs outside the game: the addon can only write SavedVariables, and only at
logout or /reload, so nothing here is live. Point it at a WoW install and either
run it once or leave it watching.

    python collect.py --once --open
    python collect.py --watch

Standard library only, so it runs on whatever Python the gaming machine has.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

DAY_SECONDS = 24 * 60 * 60
DEFAULT_RETAIN_DAYS = 7
DEFAULT_INTERVAL_SECONDS = 30
SAVED_VARIABLE = "WdpWowDB"

# Ordered by likelihood, and probed only when --wow-path is not given.
WOW_PATH_CANDIDATES = (
    r"C:\Program Files (x86)\World of Warcraft\_retail_",
    r"C:\Program Files\World of Warcraft\_retail_",
    r"D:\World of Warcraft\_retail_",
    "/Applications/World of Warcraft/_retail_",
    "~/Applications/World of Warcraft/_retail_",
)


class LuaSyntaxError(ValueError):
    """The SavedVariables file was not the Lua table dump we expect."""


class LuaReader:
    """A reader for the subset of Lua the client writes into SavedVariables:
    table constructors of strings, numbers, booleans and nested tables, with the
    `-- [1]` index comments the client appends to array entries.
    """

    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0

    def error(self, message: str) -> LuaSyntaxError:
        line = self.text.count("\n", 0, self.pos) + 1
        return LuaSyntaxError(f"{message} at line {line}")

    def skip_trivia(self) -> None:
        text, length = self.text, len(self.text)
        while self.pos < length:
            char = text[self.pos]
            if char in " \t\r\n":
                self.pos += 1
            elif text.startswith("--", self.pos):
                self.pos += 2
                if text.startswith("[[", self.pos):
                    end = text.find("]]", self.pos)
                    self.pos = length if end == -1 else end + 2
                else:
                    end = text.find("\n", self.pos)
                    self.pos = length if end == -1 else end + 1
            else:
                return

    def peek(self) -> str:
        self.skip_trivia()
        return self.text[self.pos] if self.pos < len(self.text) else ""

    def expect(self, char: str) -> None:
        if self.peek() != char:
            raise self.error(f"expected {char!r}")
        self.pos += 1

    def read_name(self) -> str:
        self.skip_trivia()
        start = self.pos
        while self.pos < len(self.text) and (self.text[self.pos].isalnum() or self.text[self.pos] == "_"):
            self.pos += 1
        if start == self.pos:
            raise self.error("expected a name")
        return self.text[start:self.pos]

    def read_string(self) -> str:
        quote = self.text[self.pos]
        self.pos += 1
        out = []
        escapes = {"n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "f": "\f", "v": "\v"}
        while True:
            if self.pos >= len(self.text):
                raise self.error("unterminated string")
            char = self.text[self.pos]
            if char == "\\":
                self.pos += 1
                escaped = self.text[self.pos]
                if escaped.isdigit():
                    digits = ""
                    while len(digits) < 3 and self.pos < len(self.text) and self.text[self.pos].isdigit():
                        digits += self.text[self.pos]
                        self.pos += 1
                    out.append(chr(int(digits)))
                    continue
                out.append(escapes.get(escaped, escaped))
                self.pos += 1
            elif char == quote:
                self.pos += 1
                return "".join(out)
            else:
                out.append(char)
                self.pos += 1

    def read_number(self) -> float | int:
        start = self.pos
        if self.text[self.pos] in "+-":
            self.pos += 1
        while self.pos < len(self.text) and (
            self.text[self.pos].isdigit() or self.text[self.pos] in ".xXaAbBcCdDeEfFpP+-"
        ):
            # A sign only continues the number when it is an exponent's sign.
            if self.text[self.pos] in "+-" and self.text[self.pos - 1] not in "eEpP":
                break
            self.pos += 1
        literal = self.text[start:self.pos]
        try:
            if literal.lower().startswith(("0x", "-0x")):
                return int(literal, 16)
            if any(mark in literal for mark in ".eE") and not literal.lower().startswith("0x"):
                return float(literal)
            return int(literal)
        except ValueError as exc:
            raise self.error(f"bad number {literal!r}") from exc

    def read_value(self):
        char = self.peek()
        if char == "{":
            return self.read_table()
        if char in "\"'":
            return self.read_string()
        if char.isdigit() or char in "+-.":
            return self.read_number()
        name = self.read_name()
        if name == "true":
            return True
        if name == "false":
            return False
        if name == "nil":
            return None
        raise self.error(f"unexpected value {name!r}")

    def read_table(self):
        self.expect("{")
        items: dict = {}
        index = 1
        while True:
            char = self.peek()
            if char == "}":
                self.pos += 1
                break
            if char == "":
                raise self.error("unterminated table")
            if char == "[":
                self.pos += 1
                key = self.read_value()
                self.expect("]")
                self.expect("=")
                items[key] = self.read_value()
            else:
                mark = self.pos
                if char.isalpha() or char == "_":
                    name = self.read_name()
                    if self.peek() == "=":
                        self.pos += 1
                        items[name] = self.read_value()
                    else:
                        # Not a key after all: rewind and take it as an array item.
                        self.pos = mark
                        items[index] = self.read_value()
                        index += 1
                else:
                    items[index] = self.read_value()
                    index += 1
            if self.peek() in ",;":
                self.pos += 1
        return as_list_if_array(items)


def as_list_if_array(items: dict):
    """Lua has one table type; JSON does not. A table whose keys are exactly 1..n
    is an array everywhere else in this pipeline, so collapse it into one.

    An empty table is genuinely ambiguous, and every empty table this reads — an
    unplayed session list, a run that earned no reputation — is an empty list."""
    if not items:
        return []
    if all(isinstance(key, int) for key in items) and set(items) == set(range(1, len(items) + 1)):
        return [items[key] for key in range(1, len(items) + 1)]
    return {str(key): value for key, value in items.items()}


def read_saved_variables(path: Path, variable: str = SAVED_VARIABLE):
    """Returns the named global from a SavedVariables file, or None when absent."""
    reader = LuaReader(path.read_text(encoding="utf-8", errors="replace"))
    while True:
        if reader.peek() == "":
            return None
        name = reader.read_name()
        reader.expect("=")
        value = reader.read_value()
        if name == variable:
            return value


def account_files(wow_path: Path) -> list[Path]:
    pattern = str(wow_path / "WTF" / "Account" / "*" / "SavedVariables" / "wdp-wow.lua")
    return [Path(match) for match in sorted(glob.glob(pattern))]


def find_wow_path(explicit: str | None) -> Path:
    if explicit:
        path = Path(os.path.expanduser(explicit))
        if not (path / "WTF").is_dir():
            raise SystemExit(f"no WTF folder under {path} — is that the _retail_ folder?")
        return path

    for candidate in WOW_PATH_CANDIDATES:
        path = Path(os.path.expanduser(candidate))
        if (path / "WTF").is_dir():
            return path

    raise SystemExit(
        "could not find a WoW install; pass --wow-path <...>/_retail_\n"
        "tried:\n  " + "\n  ".join(WOW_PATH_CANDIDATES)
    )


def default_output_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return Path(base) / "wdp-wow"
    return Path(os.path.expanduser("~/.local/share/wdp-wow"))


def normalise(record: dict) -> dict | None:
    """Keeps a session only if it carries the identity the report is built around:
    who was on, where they were, and when it ended. A session is one character's
    continuous stay in one location — an instance or an open-world zone."""
    if not isinstance(record, dict):
        return None
    if not record.get("id") or not record.get("character") or not record.get("endedAt"):
        return None

    reputation = []
    for gain in record.get("reputation") or []:
        if isinstance(gain, dict) and gain.get("faction"):
            reputation.append({"faction": str(gain["faction"]), "amount": int(gain.get("amount") or 0)})

    currencies = []
    for gain in record.get("currencies") or []:
        if isinstance(gain, dict) and gain.get("name"):
            currencies.append({
                "id": int(gain.get("id") or 0),
                "name": str(gain["name"]),
                "amount": int(gain.get("amount") or 0),
            })

    achievements = []
    for event in record.get("achievements") or []:
        if isinstance(event, dict) and event.get("name"):
            achievements.append({
                "id": int(event.get("id") or 0),
                "name": str(event["name"]),
                "at": int(event.get("at") or 0),
            })

    transmogs = []
    for event in record.get("transmogs") or []:
        if isinstance(event, dict) and event.get("id"):
            transmogs.append({
                "id": int(event["id"]),
                "at": int(event.get("at") or 0),
            })

    ended = int(record["endedAt"])
    started = int(record.get("startedAt") or ended)

    return {
        "id": str(record["id"]),
        "character": str(record["character"]),
        "classFile": str(record["classFile"]) if record.get("classFile") else None,
        "day": str(record.get("day") or datetime.fromtimestamp(ended).strftime("%Y-%m-%d")),
        "instance": str(record.get("instance") or "Unknown"),
        "difficulty": str(record.get("difficulty") or ""),
        "instanceType": str(record.get("instanceType") or ""),
        "startedAt": started,
        "endedAt": ended,
        "seconds": int(record.get("seconds") or max(ended - started, 0)),
        "lootValue": int(record.get("lootValue") or 0),
        "goldDiff": int(record.get("goldDiff") or 0),
        "transmogs": transmogs,
        "currencyTotal": int(record.get("currencyTotal") or 0),
        "reputationTotal": int(record.get("reputationTotal") or 0),
        "currencies": currencies,
        "reputation": reputation,
        "achievements": achievements,
    }


def load_database(path: Path) -> dict:
    if not path.exists():
        return {"sessions": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"sessions": []}
    if not isinstance(data, dict) or not isinstance(data.get("sessions"), list):
        return {"sessions": []}
    return data


def merge(database: dict, incoming: list[dict], retain_days: int, now: float) -> tuple[int, int]:
    """Folds freshly read sessions into the database, newest wins, then drops
    anything outside the retention window. Returns (added, dropped)."""
    by_id = {record["id"]: record for record in database["sessions"]}
    added = 0
    for record in incoming:
        if record["id"] not in by_id:
            added += 1
        by_id[record["id"]] = record

    cutoff = now - retain_days * DAY_SECONDS
    kept = [record for record in by_id.values() if record["endedAt"] >= cutoff]
    dropped = len(by_id) - len(kept)

    kept.sort(key=lambda record: (-record["endedAt"], record["id"]))
    database["sessions"] = kept
    return added, dropped


def render(database: dict, template: Path, destination: Path, retain_days: int) -> None:
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "retainDays": retain_days,
        "sessions": database["sessions"],
    }
    html = template.read_text(encoding="utf-8")
    marker = "/*__WDP_DATA__*/null"
    if marker not in html:
        raise SystemExit(f"{template} is missing the {marker} placeholder")
    # json.dumps escapes nothing that can close a <script>, except a literal "</".
    encoded = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    destination.write_text(html.replace(marker, encoded), encoding="utf-8")


def collect_once(options, template: Path) -> dict:
    wow_path = find_wow_path(options.wow_path)
    files = account_files(wow_path)
    if not files:
        print(f"!! no wdp-wow.lua under {wow_path / 'WTF' / 'Account'} — log out of WoW at least once", flush=True)

    incoming: list[dict] = []
    for path in files:
        try:
            saved = read_saved_variables(path)
        except (LuaSyntaxError, OSError) as exc:
            print(f"!! could not read {path}: {exc}", flush=True)
            continue
        sessions = (saved or {}).get("sessions") if isinstance(saved, dict) else None
        for record in sessions or []:
            cleaned = normalise(record)
            if cleaned:
                incoming.append(cleaned)

    options.out.mkdir(parents=True, exist_ok=True)
    database_path = options.out / "sessions.json"
    database = load_database(database_path)
    added, dropped = merge(database, incoming, options.days, time.time())
    database_path.write_text(json.dumps(database, indent=2, ensure_ascii=False), encoding="utf-8")

    report_path = options.out / "report.html"
    render(database, template, report_path, options.days)

    print(
        f"[{datetime.now().strftime('%H:%M:%S')}] "
        f"{len(database['sessions'])} sessions ({added} new, {dropped} expired) -> {report_path}",
        flush=True,
    )
    return {"added": added, "dropped": dropped, "report": report_path}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wow-path", help="the _retail_ folder; probed automatically when omitted")
    parser.add_argument("--out", type=Path, default=default_output_dir(), help="where the database and report go")
    parser.add_argument("--days", type=int, default=DEFAULT_RETAIN_DAYS, help="days of history to keep")
    parser.add_argument("--watch", action="store_true", help="keep running, re-collecting on every change")
    parser.add_argument(
        "--interval", type=int, default=DEFAULT_INTERVAL_SECONDS, help="seconds between polls in --watch mode"
    )
    parser.add_argument("--open", action="store_true", help="open the report in a browser when it is built")
    parser.add_argument("--once", action="store_true", help="collect a single time (the default)")
    options = parser.parse_args(argv)

    template = Path(__file__).resolve().parent.parent / "web" / "report.template.html"
    if not template.exists():
        raise SystemExit(f"report template not found at {template}")

    result = collect_once(options, template)
    if options.open:
        webbrowser.open(result["report"].as_uri())

    if not options.watch:
        return 0

    print(f"watching every {options.interval}s — Ctrl+C to stop", flush=True)
    # Seeded from the collection above, so the first poll only fires on a real change.
    signatures = {path: path.stat().st_mtime for path in account_files(find_wow_path(options.wow_path))}
    try:
        while True:
            time.sleep(options.interval)
            wow_path = find_wow_path(options.wow_path)
            current = {path: path.stat().st_mtime for path in account_files(wow_path) if path.exists()}
            if current != signatures:
                signatures = current
                collect_once(options, template)
    except KeyboardInterrupt:
        print("stopped", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
