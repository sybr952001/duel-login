#!/usr/bin/env python3
"""Bundle the app into one self-contained HTML file.

The sources are plain ES modules. Rather than depend on a bundler being
installed, this concatenates them in dependency order after stripping the
import/export statements - the modules share no top-level identifiers, which
`check_collisions()` below asserts.
"""

import base64
import gzip
import hashlib
import hmac
import os
import re
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
OUT = DIST / "duel-login.html"

# Dependency order: a module may only use names declared by earlier ones.
MODULES = ["engine.js", "effects.js", "driver.js", "puzzle.js", "auth.js", "app.js"]

DECL = re.compile(
    r"^(?:export\s+)?(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)",
    re.M,
)


def strip_module(text: str, name: str) -> str:
    """Remove import statements, export lists and export keywords."""
    lines = text.split("\n")
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if re.match(r"^\s*import\b", line):
            # Consume until the statement terminates (imports span lines here).
            while i < len(lines) and not re.search(r"['\"]\s*;?\s*$", lines[i]):
                i += 1
            i += 1
            continue
        if re.match(r"^\s*export\s*\{", line):
            while i < len(lines) and "}" not in lines[i]:
                i += 1
            i += 1
            continue
        out.append(line)
        i += 1
    text = "\n".join(out)
    text = re.sub(r"^export\s+(?=(?:const|let|var|function|class|async function)\b)", "", text, flags=re.M)
    if re.search(r"^\s*(import|export)\b", text, flags=re.M):
        raise SystemExit(f"{name}: an import/export statement survived stripping")
    return text


def check_collisions() -> None:
    seen: dict[str, str] = {}
    for name in MODULES:
        text = (SRC / name).read_text()
        for m in DECL.finditer(text):
            ident = m.group(1)
            if ident in seen:
                raise SystemExit(
                    f"top-level identifier {ident!r} is declared in both "
                    f"{seen[ident]} and {name}; the bundle would shadow one of them"
                )
            seen[ident] = name


def pbkdf2_sha256(password: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)


def build() -> None:
    check_collisions()

    db_b64 = (SRC / "carddb.b64").read_text().strip()
    raw = gzip.decompress(base64.b64decode(db_b64))
    cards = len(__import__("json").loads(raw.decode("utf-8")))

    password = os.environ.get("DUEL_PASSWORD", "duelist")
    iterations = int(os.environ.get("DUEL_ITERATIONS", "210000"))
    salt = secrets.token_bytes(16)
    digest = pbkdf2_sha256(password, salt, iterations)
    credential = (
        '{"salt":"%s","iterations":%d,"hash":"%s"}'
        % (base64.b64encode(salt).decode(), iterations, base64.b64encode(digest).decode())
    )

    parts = []
    for name in MODULES:
        body = strip_module((SRC / name).read_text(), name)
        parts.append(f"/* ==== {name} ==== */\n{body.strip()}\n")

    bundle = "\n".join(parts)
    bundle = bundle.replace("'__CARD_DB_B64__'", json_str(db_b64))
    bundle = bundle.replace("'__CREDENTIAL__'", json_str(credential))
    for placeholder in ("__CARD_DB_B64__", "__CREDENTIAL__"):
        if placeholder in bundle:
            raise SystemExit(f"placeholder {placeholder} was not substituted")

    js = "(function () {\n'use strict';\n" + bundle + "\n})();\n"
    css = (SRC / "style.css").read_text()

    html = (SRC / "index.html").read_text()
    html = html.replace("<!--INLINE_CSS-->", "<style>\n" + css + "\n</style>")
    # A module script would need a server; an inline classic script works from file://
    html = html.replace("<!--INLINE_JS-->", "<script>\n" + js + "\n</script>")

    DIST.mkdir(exist_ok=True)
    OUT.write_text(html)

    # The bundle must at least parse.
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as fh:
        fh.write(js)
        tmp = fh.name
    try:
        check = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
        if check.returncode != 0:
            raise SystemExit(f"generated bundle does not parse:\n{check.stderr}")
    finally:
        os.unlink(tmp)

    print(f"wrote {OUT.relative_to(ROOT)}  ({OUT.stat().st_size / 1e6:.2f} MB)")
    print(f"  cards      : {cards}")
    print(f"  password   : {password!r}  (set DUEL_PASSWORD to change it)")
    print(f"  iterations : {iterations} PBKDF2-SHA256")


def json_str(s: str) -> str:
    import json

    return json.dumps(s)


if __name__ == "__main__":
    build()
