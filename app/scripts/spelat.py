#!/usr/bin/env python3
"""Markera ett frågeset som spelat så att frågorna vilar några kvällar.

Kör från app/:
  python3 scripts/spelat.py 2026-10-30 2026-10-30-fredagsquiz [fler-set-id ...]
  python3 scripts/spelat.py --lista

Skriver till quizzes/spelat/register.json. Bara alternativfrågor sparas (skill-utmaningar
slumpas om varje gång och får gärna komma igen). Frågetexten sparas, så en fråga som
kopieras till ett annat set känns ändå igen. Hur länge frågorna vilar styrs av "karens".
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
QUIZZES = os.path.join(HERE, "..", "quizzes")
REGISTER = os.path.join(QUIZZES, "spelat", "register.json")


def load_register():
    if os.path.exists(REGISTER):
        with open(REGISTER, encoding="utf-8") as f:
            return json.load(f)
    return {"karens": 4, "kvallar": []}


def save_register(reg):
    os.makedirs(os.path.dirname(REGISTER), exist_ok=True)
    with open(REGISTER, "w", encoding="utf-8") as f:
        json.dump(reg, f, ensure_ascii=False, indent=2)
        f.write("\n")


def sets_by_id():
    out = {}
    for path in glob.glob(os.path.join(QUIZZES, "*.json")):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        out[d["id"]] = d
    return out


def main(argv):
    reg = load_register()
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "--lista":
        print(f"Karens: {reg['karens']} kvällar")
        for k in reg["kvallar"]:
            print(f"{k['datum']}  {k['titel']} ({k['set']}): {len(k['fragor'])} frågor")
        return 0
    datum, ids = argv[0], argv[1:]
    if len(datum) != 10 or not ids:
        print("Användning: spelat.py ÅÅÅÅ-MM-DD set-id [set-id ...]", file=sys.stderr)
        return 1
    sets = sets_by_id()
    for sid in ids:
        if sid not in sets:
            print(f"Hittar inget set med id {sid}. Finns: {', '.join(sorted(sets))}", file=sys.stderr)
            return 1
        s = sets[sid]
        texts = [q["text"] for q in s["questions"] if q.get("mode") != "skill" and q.get("text")]
        reg["kvallar"] = [k for k in reg["kvallar"] if not (k["datum"] == datum and k["set"] == sid)]
        reg["kvallar"].append({"datum": datum, "set": sid, "titel": s["title"], "fragor": texts})
        print(f"{datum}: {s['title']} markerat som spelat ({len(texts)} frågor vilar).")
    reg["kvallar"].sort(key=lambda k: (k["datum"], k["set"]))
    save_register(reg)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
