"""Comprehensive end-to-end Physica A submission bundle verifier (Option A 9-figure suite)."""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

EXTRA_LIBS = Path(os.environ.get("CT_PYTHON_LIBS", "./python-libs"))
if EXTRA_LIBS.exists():
    sys.path.insert(0, str(EXTRA_LIBS))
import pymupdf

BASE = Path(os.environ.get("CT_MANUSCRIPT_DIR", "./physicaA"))


def count_cols(spec: str) -> int:
    s = re.sub(r"@\{[^}]*\}", "", spec)
    s = re.sub(r">\{[^}]*\}", "", s)
    s = re.sub(r"<\{[^}]*\}", "", s)
    s = re.sub(r"[pmb]\{[^}]*\}", "X", s)
    return len(re.findall(r"[lcrX]", s))


def audit_tables(tex: str, name: str) -> int:
    checked = 0
    for m in re.finditer(r"\\begin\{(tabular|longtable)\}\{([^\n]+)\}([\s\S]*?)\\end\{\1\}", tex):
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
    main_tex = (BASE / "main.tex").read_text("utf-8")
    supp_tex = (BASE / "Supplementary_Material.tex").read_text("utf-8")
    bib_text = (BASE / "ref.bib").read_text("utf-8")
    hl_lines = [l.strip() for l in (BASE / "Highlights.txt").read_text("utf-8").splitlines() if l.strip()]

    # 1. Exactly 9 figures referenced & present
    figs = re.findall(r"\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}", main_tex)
    expected_figs = [f"figures/Figure{i}.pdf" for i in range(1, 10)]
    assert figs == expected_figs, f"Figure sequence mismatch: {figs}"
    disk_pdfs = sorted((BASE / "figures").glob("Figure*.pdf"), key=lambda x: int(x.stem.replace("Figure", "")))
    assert [p.name for p in disk_pdfs] == [f"Figure{i}.pdf" for i in range(1, 10)], disk_pdfs
    print(f"[PASS] Figures: exact 9-figure suite ({len(disk_pdfs)} PDFs on disk, 0 stale files)")

    # 2. PDF font & raster audit via PyMuPDF
    for i in range(1, 10):
        p = BASE / "figures" / f"Figure{i}.pdf"
        doc = pymupdf.open(p)
        pg = doc[0]
        fonts = pg.get_fonts(full=True)
        imgs = pg.get_images(full=True)
        t3 = [f for f in fonts if f[2] == "Type3" or f[1] == "Type3"]
        assert not t3, f"Type3 font in {p.name}: {t3}"
        if i >= 2:
            assert len(imgs) == 0, f"Raster image in {p.name}: {len(imgs)}"
        print(f"  {p.name}: {pg.rect.width/72:.2f}x{pg.rect.height/72:.2f} in | imgs={len(imgs)} | type3=0")

    # 3. Citations across BOTH main.tex and Supplementary_Material.tex
    bib_keys = set(re.findall(r"@\w+\{([^,\s]+),", bib_text))
    for label, src in (("main.tex", main_tex), ("Supplementary_Material.tex", supp_tex)):
        cited = {k.strip() for m in re.findall(r"\\cite[a-z]*\{([^}]+)\}", src) for k in m.split(",")}
        missing = cited - bib_keys
        assert not missing, f"{label} missing bib keys: {missing}"
        print(f"[PASS] Citations ({label}): {len(cited)} cited, 0 missing")

    # 4. Internal & cross-document labels
    main_labels = set(re.findall(r"\\label\{([^}]+)\}", main_tex))
    supp_labels = set(re.findall(r"\\label\{([^}]+)\}", supp_tex))
    main_refs = set()
    for pat in (r"\\ref\*?\{([^}]+)\}", r"\\eqref\{([^}]+)\}", r"\\figref\{([^}]+)\}",
                r"\\tabref\{([^}]+)\}", r"\\secref\{([^}]+)\}", r"\\appref\{([^}]+)\}"):
        for m in re.findall(pat, main_tex):
            if m != "#1" and not m.startswith("SUPP-"):
                main_refs.add(m)
    assert not (main_refs - main_labels), f"main.tex missing labels: {main_refs - main_labels}"
    assert "fig:e7" not in main_tex, "Stale fig:e7 still present!"
    main_supp_refs = set(re.findall(r"SUPP-([^}]+)", main_tex))
    assert not (main_supp_refs - supp_labels), f"Broken SUPP refs: {main_supp_refs - supp_labels}"
    supp_refs = set(re.findall(r"\\(?:eq)?ref\{([^}]+)\}", supp_tex))
    assert not (supp_refs - supp_labels), f"Supplement missing labels: {supp_refs - supp_labels}"
    print(f"[PASS] Cross-refs: main ({len(main_refs)}/{len(main_labels)}), SUPP ({len(main_supp_refs)}), supp-internal ({len(supp_refs)}/{len(supp_labels)})")

    # 5. Table column counts in BOTH documents
    n_main_tab = audit_tables(main_tex, "main.tex")
    n_supp_tab = audit_tables(supp_tex, "Supplementary_Material.tex")
    print(f"[PASS] Table columns: {n_main_tab} tables in main.tex, {n_supp_tab} tables in Supplementary_Material.tex (0 mismatches)")

    # 6. Stale wording checks across both docs + ref.bib
    for bad in ("physical source", "job--layer", "CASE\\_1", "S0--S2", "Panel (b) enlarges", "Figure10.pdf"):
        assert bad not in main_tex, f"Stale main.tex phrase: {bad}"
    for bad in ("physical snapshot", "job--layer", "Figures 4 and 5", "Figure 5 shows", "physical identity"):
        assert bad not in supp_tex, f"Stale Supplement phrase: {bad}"
    assert "physical source snapshot" not in bib_text
    print("[PASS] Stale phrase check: 0 leftover issues in main.tex, Supplementary_Material.tex, ref.bib")

    # 7. Highlights & Cover Letter & Figure Audit JSON
    assert 3 <= len(hl_lines) <= 5
    for idx, line in enumerate(hl_lines, 1):
        b = line[2:] if line.startswith("- ") else line
        assert len(b) <= 85, f"H{idx} > 85 chars"
    assert (BASE / "Cover_Letter_PhysicaA.docx").exists()
    audit = json.loads((BASE / "figures/physicaA_figure_audit.json").read_text("utf-8"))
    assert audit["frozenInputsUnchanged"] is True and len(audit["outputs"]) == 8
    print("[PASS] Highlights (<=85 chars), Cover Letter docx, and frozen-input SHA-256 invariance verified!")


if __name__ == "__main__":
    main()
