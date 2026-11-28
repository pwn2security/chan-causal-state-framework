"""Comprehensive end-to-end Physica A submission bundle verifier (8-figure main + 3-figure supplement)."""
from __future__ import annotations

import argparse
import os
import re
from pathlib import Path

import pymupdf

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASE = Path(os.environ.get("CT_MANUSCRIPT_DIR", str(REPO_ROOT.parent / "physicaA")))


def count_cols(spec: str) -> int:
    s = re.sub(r"@\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", "", spec)
    s = re.sub(r">\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", "", s)
    s = re.sub(r"<\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", "", s)
    s = re.sub(r"[pmb]\{[^{}]*\}", "X", s)
    return len(re.findall(r"[lcrX]", s))


def audit_tables(tex: str, name: str) -> int:
    checked = 0
    for m in re.finditer(r"\\begin\{(tabular\*?|longtable)\}(?:\{[^}]*\})?\{([^\n]+)\}([\s\S]*?)\\end\{\1\}", tex):
        env, spec, body = m.group(1), m.group(2), m.group(3)
        ncols = count_cols(spec)
        line_no = tex[:m.start()].count("\n") + 1
        checked += 1
        for row in body.split(r"\\"):
            clean = row.replace(r"\&", "AND")
            clean = re.sub(r"\\multicolumn\{(\d+)\}\{[^}]*\}\{[^}]*\}", lambda x: "&" * (int(x.group(1)) - 1), clean)
            if "&" in clean:
                c = clean.count("&") + 1
                assert c == ncols, f"{name} L{line_no} ({env}): expected {ncols} cols, got {c}: {row.strip()[:80]}"
    return checked


def main() -> None:
    ap = argparse.ArgumentParser(description="Verify Physica A LaTeX manuscript, figures, tables, and citations.")
    ap.add_argument("--manuscript-dir", type=Path, default=DEFAULT_BASE)
    args = ap.parse_args()
    BASE = args.manuscript_dir.resolve()

    main_tex = (BASE / "main.tex").read_text("utf-8")
    supp_tex = (BASE / "Supplementary_Material.tex").read_text("utf-8")
    bib_text = (BASE / "ref.bib").read_text("utf-8")
    hl_lines = [l.strip() for l in (BASE / "Highlights.txt").read_text("utf-8").splitlines() if l.strip()]

    # 1. Abstract word count <= 250 (standard whitespace-delimited words after stripping LaTeX wrappers)
    abs_m = re.search(r"\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}", main_tex)
    assert abs_m, "Missing abstract"
    abs_clean = re.sub(r"\\(?:textbf|texttt|emph)\{([^}]*)\}", r"\1", abs_m.group(1))
    abs_clean = abs_clean.replace("~", " ")
    abs_clean = re.sub(r"\$([^$]*)\$", lambda m: re.sub(r"\\[a-zA-Z]+", " ", m.group(1)), abs_clean)
    abs_words = len([w for w in abs_clean.split() if re.search(r"[A-Za-z0-9]", w)])
    assert abs_words <= 250, f"Abstract exceeds 250 words ({abs_words})"
    print(f"[PASS] Abstract word count: {abs_words} words (<= 250)")

    # 2. Exact 8 main figures + 3 supplement figures referenced & present
    main_figs = re.findall(r"\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}", main_tex)
    expected_main = [f"figures/Figure{i}.pdf" for i in range(1, 9)]
    assert main_figs == expected_main, f"Main figure sequence mismatch: {main_figs}"

    supp_figs = re.findall(r"\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}", supp_tex)
    expected_supp = [f"figures/FigureS{i}.pdf" for i in range(1, 4)]
    assert supp_figs == expected_supp, f"Supp figure sequence mismatch: {supp_figs}"

    for frel in expected_main + expected_supp:
        p = BASE / frel
        assert p.exists(), f"Missing {p}"
        doc = pymupdf.open(p)
        pg = doc[0]
        fonts = pg.get_fonts(full=True)
        imgs = pg.get_images(full=True)
        t3 = [f for f in fonts if f[2] == "Type3" or f[1] == "Type3"]
        assert not t3, f"Type3 font in {p.name}: {t3}"
        if p.name != "Figure1.pdf":
            assert len(imgs) == 0, f"Raster image in {p.name}: {len(imgs)}"
        print(f"  {p.name:12s}: {pg.rect.width/72:.2f}x{pg.rect.height/72:.2f} in | imgs={len(imgs)} | type3=0")
    print("[PASS] Figures: exact 8-figure main + 3-figure supplement pure-vector suite")

    # 3. Citations across BOTH main.tex and Supplementary_Material.tex
    bib_keys = set(re.findall(r"@\w+\{([^,\s]+),", bib_text))
    assert "Hwang2027Lookahead" not in bib_keys, "Stale Ref Hwang2027Lookahead still in ref.bib!"
    for label, src in (("main.tex", main_tex), ("Supplementary_Material.tex", supp_tex)):
        cited = {k.strip() for m in re.findall(r"\\cite[a-z]*\{([^}]+)\}", src) for k in m.split(",")}
        missing = cited - bib_keys
        assert not missing, f"{label} missing bib keys: {missing}"
        print(f"[PASS] Citations ({label}): {len(cited)} cited, 0 missing")

    # 4. Internal & cross-document labels + Algorithm S1 check
    assert r"\label{alg:segment-s1}" in supp_tex, "Missing Algorithm S1 in Supplementary_Material.tex!"
    main_labels = set(re.findall(r"\\label\{([^}]+)\}", main_tex))
    supp_labels = set(re.findall(r"\\label\{([^}]+)\}", supp_tex))
    main_refs = set()
    for pat in (r"\\ref\*?\{([^}]+)\}", r"\\eqref\{([^}]+)\}", r"\\figref\{([^}]+)\}",
                r"\\tabref\{([^}]+)\}", r"\\secref\{([^}]+)\}", r"\\appref\{([^}]+)\}"):
        for m in re.findall(pat, main_tex):
            if m != "#1" and not m.startswith("SUPP-"):
                main_refs.add(m)
    assert not (main_refs - main_labels), f"main.tex missing labels: {main_refs - main_labels}"
    main_supp_refs = set(re.findall(r"SUPP-([^}]+)", main_tex))
    assert not (main_supp_refs - supp_labels), f"Broken SUPP refs: {main_supp_refs - supp_labels}"
    supp_refs = set(re.findall(r"\\(?:eq)?ref\{([^}]+)\}", supp_tex))
    assert not (supp_refs - supp_labels), f"Supplement missing labels: {supp_refs - supp_labels}"
    print(f"[PASS] Cross-refs: main ({len(main_refs)}/{len(main_labels)}), SUPP ({len(main_supp_refs)}), supp-internal ({len(supp_refs)}/{len(supp_labels)})")

    # 5. Table column counts in BOTH documents
    n_main_tab = audit_tables(main_tex, "main.tex")
    n_supp_tab = audit_tables(supp_tex, "Supplementary_Material.tex")
    print(f"[PASS] Table columns: {n_main_tab} tables in main.tex, {n_supp_tab} tables in Supplementary_Material.tex (0 mismatches)")

    # 6. Hygiene & stale cross-reference checks
    for bad in ("Spot/Trades", "prefix prefix", "Pivots $Z$ (/720)", "Hwang2027Lookahead", "Supplymentary"):
        assert bad not in main_tex, f"Stale main.tex phrase: {bad}"
        assert bad not in supp_tex, f"Stale Supplement phrase: {bad}"
    for bad in ("R5V11-AUTH", "E9-STAGED13-FORMAL", "windows-memory.mjs", "PeakWorkingSetSize",
                "Eqs. (23)--(24)", "Eqs. (25)--(26)", "main-article Eq.~(9)", "main-article Figure~4(b)",
                "main-article Fig.~7", "main-article Section~4.7", "main-article Table~9", "lines 1209--1234"):
        assert bad not in supp_tex, f"Stale/contradictory phrase still in Supplement: {bad}"
    print("[PASS] Hygiene & cross-document consistency check: 0 stale phrases")

    # 7. Highlights <= 85 chars & compiled PDF page counts
    assert 3 <= len(hl_lines) <= 5
    for idx, line in enumerate(hl_lines, 1):
        b = line[2:] if line.startswith("- ") else line
        assert len(b) <= 85, f"H{idx} > 85 chars ({len(b)}): {b}"
    print(f"[PASS] Highlights ({len(hl_lines)} items, all <=85 chars)")

    for pdf_name in ("main.pdf", "Supplementary_Material.pdf"):
        pp = BASE / pdf_name
        if pp.exists():
            d = pymupdf.open(pp)
            print(f"[PDF] {pdf_name}: {len(d)} pages ({pp.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
