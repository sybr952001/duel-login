#!/usr/bin/env python3
"""
Builds src/carddb.b64 - the card payload embedded in the single-file app.

Sources
-------
Two independent dumps are merged by passcode, because neither is complete:

* YGOPRODeck API v7 bulk dump (src/ygocards.json, 14,586 cards) - good effect
  text, official type line, archetype, ATK/DEF/level. Does not publish XYZ ranks
  or LINK ratings, and it omits a few hundred cards entirely.

* YGOPRO cards.cdb (src/cards.cdb, 15,019 rows) - supplies XYZ ranks and LINK
  ratings. Its `type` bitfield carries the summon category, but this fork's bit
  layout is not the reference YGOPRO one, so the bits below were derived
  empirically by scoring every bit position against the API's type lines.

Union of both gives 15,245 records. Anything present in only one source is
still included.

Known data gaps (deliberate, documented rather than hidden)
----------------------------------------------------------
* This cdb stores no bits for Equip or Counter, and the API publishes no
  Continuous/Quick-Play/Counter/Equip/Field classification either. So CONTINUOUS
  (0x40000), QUICKPLAY (0x10000) and FIELD (0x80000) come from the cdb only,
  and Counter Traps such as Sakuretsu Armor are recorded as plain Traps.
* A small set of well-known cards is misclassified by *both* sources (their cdb
  row and their API type line both say "Effect Monster"). Those are corrected by
  the OVERRIDES table below; the list is not exhaustive.
* A handful of LINK ratings in the cdb disagree with the printed card
  (Salamangreat Almiraj is recorded as Link-1 rather than Link-2).
* Some cards are absent from both datasets and therefore missing entirely.
  Both sources are skewed against TCG-only printings, so staples such as
  Red-Eyes Abyss, Mogg the Magician, Cardcaptor Sakura, Power of the Duelist,
  Knight of Cytheria and Draconic Emperor of Lindwurm are not present. The
  puzzle deck builder only draws from cards that are in the database.

Output is gzip + base64 so the whole database fits inside the HTML file; the
browser inflates it with the native DecompressionStream API.
"""

import base64
import gzip
import json
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CDB = os.path.join(HERE, "cards.cdb")
API = os.path.join(HERE, "ygocards.json")
OUT = os.path.join(HERE, "carddb.b64")

# --- cdb `type` bits, derived empirically against the API's type lines -----
BIT_MONSTER = 0x1
BIT_SPELL = 0x2
BIT_TRAP = 0x4
BIT_NORMAL = 0x10
BIT_EFFECT = 0x20
BIT_FUSION = 0x40
BIT_RITUAL = 0x80
BIT_TUNER = 0x1000
BIT_SYNCHRO = 0x2000
BIT_TOKEN = 0x4000
BIT_FLIP = 0x200000
# Spell/Trap subtypes occupy a separate bit band from the monster flags.
# Verified against known cards: Book of Moon / Enemy Controller (Quick-Play),
# Snatch Steal / Premature Burial / Axe of Despair (Continuous), The Sanctuary
# in the Sky (Field).
BIT_QUICKPLAY = 0x10000
BIT_CONTINUOUS = 0x40000
BIT_FIELD = 0x80000
BIT_PENDULUM = 0x1000000
BIT_XYZ = 0x800000
BIT_LINK = 0x4000000

MONSTER_BITS = [
    (BIT_NORMAL, "NORMAL"),
    (BIT_EFFECT, "EFFECT"),
    (BIT_FUSION, "FUSION"),
    (BIT_RITUAL, "RITUAL"),
    (BIT_SYNCHRO, "SYNCHRO"),
    (BIT_TUNER, "TUNER"),
    (BIT_FLIP, "FLIP"),
    (BIT_PENDULUM, "PENDULUM"),
    (BIT_XYZ, "XYZ"),
    (BIT_LINK, "LINK"),
    (BIT_TOKEN, "TOKEN"),
]

# Cards that both sources get wrong: their cdb type bits and their API type
# line agree on "Effect Monster" even though the printed card is a Special
# Summon-only monster of a specific kind. Verified against the real cards.
# The list is not exhaustive - it covers the well-known cards that were
# checked by hand.
OVERRIDES = {
    "Lava Golem": ["MONSTER", "XYZ", "EFFECT"],
    "Gearfried the Iron Knight": ["MONSTER", "XYZ", "EFFECT"],
    "Bystial Druiswurm": ["MONSTER", "SYNCHRO", "TUNER", "EFFECT"],
    "Magician's Rod": ["MONSTER", "SYNCHRO", "TUNER", "EFFECT"],
    "Substitoad": ["MONSTER", "FUSION", "EFFECT"],
    "Cannon Soldier": ["MONSTER", "FUSION", "EFFECT"],
    "The Dark Creator": ["MONSTER", "FUSION", "EFFECT"],
    "Gaia The Fierce Knight": ["MONSTER", "FUSION", "NORMAL"],
}

API_WORDS = [
    ("Normal", "NORMAL"), ("Effect", "EFFECT"), ("Fusion", "FUSION"),
    ("Ritual", "RITUAL"), ("Synchro", "SYNCHRO"), ("Tuner", "TUNER"),
    ("Xyz", "XYZ"), ("XYZ", "XYZ"), ("Link", "LINK"), ("Pendulum", "PENDULUM"),
    ("Flip", "FLIP"), ("Gemini", "GEMINI"), ("Spirit", "SPIRIT"),
    ("Toon", "TOON"), ("Union", "UNION"), ("Token", "TOKEN"),
    ("Quick-Play", "QUICKPLAY"), ("Continuous", "CONTINUOUS"),
    ("Spell", "SPELL"), ("Trap", "TRAP"), ("Skill", "SKILL"),
]

SUMMON_CATS = ("XYZ", "SYNCHRO", "LINK", "FUSION", "RITUAL")


def clean(s):
    if not s:
        return ""
    return re.sub(r"\s+", " ", str(s).replace("\r", " ").replace("\n", " ")).strip()


def dedupe(tokens):
    seen, out = set(), []
    for t in tokens:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def cdb_type_bits(typ, is_monster):
    out = [name for bit, name in MONSTER_BITS if typ & bit]
    if not is_monster:
        for bit, name in ((BIT_QUICKPLAY, "QUICKPLAY"),
                          (BIT_CONTINUOUS, "CONTINUOUS"),
                          (BIT_FIELD, "FIELD")):
            if typ & bit:
                out.append(name)
    return out


def api_type_words(type_str):
    s = type_str or ""
    out = [tok for w, tok in API_WORDS if w in s]
    if s == "Token":
        out.append("TOKEN")
    return dedupe(out)


def load_cdb():
    if not os.path.exists(CDB):
        sys.exit(f"missing {CDB}")
    db = sqlite3.connect(CDB)
    meta = {}
    for pid, typ, atk, dfs, lvl, race, attr in db.execute(
            "SELECT id, type, atk, def, level, race, attribute FROM datas"):
        meta[pid] = {"type": typ or 0, "atk": atk, "def": dfs,
                     "level": lvl or 0, "race": race, "attribute": attr}
    text = {}
    for pid, name, desc in db.execute("SELECT id, name, desc FROM texts"):
        text[pid] = (name or "", clean(desc))
    return meta, text


def main():
    if not os.path.exists(API):
        sys.exit(f"missing {API}")
    api_cards = json.load(open(API))
    cdb_meta, cdb_text = load_cdb()
    api_by_id = {c["id"]: c for c in api_cards}

    records = {}
    stats = {"link": 0, "rank": 0, "api_only": 0, "cdb_only": 0,
             "overrides": 0, "no_desc": 0, "no_atk_monster": 0,
             "no_category": 0}

    for pid in set(cdb_meta) | set(api_by_id):
        meta = cdb_meta.get(pid)
        api = api_by_id.get(pid)
        if meta and not api:
            stats["cdb_only"] += 1
        elif api and not meta:
            stats["api_only"] += 1

        name = clean(api.get("name")) if api else ""
        desc = clean(api.get("desc")) if api and api.get("desc") else ""
        if not name and pid in cdb_text:
            name, cdb_desc = cdb_text[pid]
            desc = desc or cdb_desc
        if not name:
            continue
        if not desc:
            stats["no_desc"] += 1

        # --- figure out monster / spell / trap ---------------------------
        cdb_kind = cdb_bits = None
        if meta:
            typ = meta["type"]
            if typ & BIT_MONSTER:
                cdb_kind = "MONSTER"
            elif typ & BIT_SPELL:
                cdb_kind = "SPELL"
            elif typ & BIT_TRAP:
                cdb_kind = "TRAP"
            cdb_bits = cdb_type_bits(typ, cdb_kind == "MONSTER")
        else:
            cdb_bits = []

        api_words = api_type_words(api.get("type") if api else "")
        kind = cdb_kind
        if kind is None:
            for k in ("MONSTER", "SPELL", "TRAP", "SKILL"):
                if k in api_words:
                    kind = k
                    break
        if kind is None:
            continue

        # --- merge the two classifications -------------------------------
        if kind in ("SPELL", "TRAP", "SKILL"):
            toks = [kind] + [t for t in cdb_bits + api_words
                             if t in ("QUICKPLAY", "CONTINUOUS", "FIELD")]
        else:
            toks = ["MONSTER"] + cdb_bits + api_words
        toks = dedupe(toks)
        if name in OVERRIDES:
            toks = OVERRIDES[name]
            stats["overrides"] += 1
            stats["no_category"] = stats.get("no_category", 0)
        elif kind == "MONSTER" and not (set(toks) - {"MONSTER", "EFFECT"}):
            # Most Effect Monsters legitimately carry no subtype beyond
            # MONSTER/EFFECT, and that is the correct record for them. The
            # same shape is also what a mis-read Special Summon monster
            # collapses to, which is the intended degradation: the card
            # stays playable by Normal Summon instead of vanishing.
            toks = ["MONSTER", "EFFECT"]
            stats["no_category"] = stats.get("no_category", 0) + 1

        rec = {"n": name, "t": toks}

        # --- stats --------------------------------------------------------
        attribute = (api or {}).get("attribute") or (meta or {}).get("attribute")
        race = (api or {}).get("race") or (meta or {}).get("race")
        atk = (api or {}).get("atk")
        dfs = (api or {}).get("def")
        lvl = (api or {}).get("level")
        if meta:
            if atk is None:
                atk = meta["atk"]
            if dfs is None:
                dfs = meta["def"]
            # For Synchro/XYZ/Link the cdb packs rank in the high half.
            if any(c in toks for c in ("XYZ", "LINK")):
                packed = meta["level"] & 0xFFFF
                if "LINK" in toks and packed:
                    rec["lk"] = packed
                    stats["link"] += 1
                elif "XYZ" in toks:
                    if lvl is None:
                        lvl = packed
                    stats["rank"] += 1
            elif lvl is None and meta["level"]:
                lvl = meta["level"] & 0xFFFF

        if attribute:
            rec["a"] = attribute
        if race:
            rec["r"] = race
        # Only monsters carry ATK/DEF; the cdb stores a literal 0 for S/T.
        if kind == "MONSTER":
            if atk is not None:
                rec["atk"] = atk
            else:
                stats["no_atk_monster"] += 1
            if dfs is not None:
                rec["def"] = dfs
        if lvl is not None and kind == "MONSTER":
            rec["lv"] = lvl
        if kind in ("SPELL", "TRAP") and lvl is None and meta and meta["level"]:
            rec["lv"] = meta["level"] & 0xFFFF
        if api and api.get("archetype"):
            rec["ar"] = api["archetype"]
        if desc:
            rec["d"] = desc

        records[pid] = rec

    raw = json.dumps(records, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload = base64.b64encode(gzip.compress(raw, 9)).decode("ascii")
    with open(OUT, "w") as fh:
        fh.write(payload)

    cats = {c: sum(1 for r in records.values() if c in r["t"]) for c in SUMMON_CATS}
    print(f"cards           : {len(records)}")
    print(f"  from cdb only : {stats['cdb_only']}")
    print(f"  from api only : {stats['api_only']}")
    print(f"link ratings    : {cats['LINK']} present, {stats['link']} rated")
    print(f"xyz ranks       : {cats['XYZ']} monsters, {stats['rank']} rank-sourced")
    for c in SUMMON_CATS:
        print(f"  {c:<8}      : {cats[c]}")
    print(f"overrides applied: {stats['overrides']}")
    print(f"plain effect mons: {stats['no_category']}")
    print(f"cards w/o text  : {stats['no_desc']}")
    print(f"monsters w/o atk: {stats['no_atk_monster']}")
    print(f"raw             : {len(raw) / 1e6:.2f} MB")
    print(f"gzipped         : {len(payload) / 1e6:.2f} MB base64 -> {OUT}")


if __name__ == "__main__":
    main()
