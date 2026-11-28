"""R7 global support-domain one-to-one matcher with all-optima ambiguity preservation.

Pure algorithmic extraction of the unmodified R7 cross-implementation matcher
(match_layer, metrics, solve_component, candidate, edge_value, distribution)
used by Exp 3 counterfactual scripts (Tables 10, 11, and S12.4).
Zero external project paths; requires only numpy and scipy.
"""
from __future__ import annotations

import random
from collections import Counter
import numpy as np
from scipy.optimize import linear_sum_assignment


def candidate(a: dict, b: dict, layer: str) -> bool:
    if layer != "K" and a["direction"] != b["direction"]:
        return False
    if not set(a["startSupport"]).intersection(b["startSupport"]):
        return False
    return layer in "KF" or bool(set(a["endSupport"]).intersection(b["endSupport"]))


def edge_value(a: dict, b: dict) -> tuple[int, int]:
    return (
        int(a["commonAnchors"] == b["commonAnchors"]),
        sum(abs(x - y) for x, y in zip(a["commonAnchors"], b["commonAnchors"])),
    )


def solve_component(
    n: int,
    m: int,
    edges: dict[tuple[int, int], tuple[int, int]],
    excluded: tuple[int, int] | None = None,
    forced: tuple[int, int] | None = None,
):
    if not edges:
        return (0, 0, 0), []
    t = min(n, m)
    maxd = max(d for _same, d in edges.values())
    exact_weight = t * maxd + 1
    card_weight = t * exact_weight + t * maxd + 1
    invalid = -(n + m + 1) * (card_weight + exact_weight + maxd + 1)
    cost = np.zeros((n + m, n + m), dtype=np.int64)
    cost[:n, :m] = invalid
    for (i, j), (same, d) in edges.items():
        if (i, j) == excluded:
            continue
        if forced is not None and (i == forced[0] or j == forced[1]) and (i, j) != forced:
            continue
        cost[i, j] = card_weight + same * exact_weight - d
    rr, cc = linear_sum_assignment(cost, maximize=True)
    chosen = [(int(i), int(j)) for i, j in zip(rr, cc) if i < n and j < m and cost[i, j] > 0]
    if forced is not None and forced not in chosen:
        return None, []
    objective = (
        len(chosen),
        sum(edges[x][0] for x in chosen),
        -sum(edges[x][1] for x in chosen),
    )
    return objective, chosen


def match_layer(internal: list[dict], external: list[dict], layer: str) -> dict:
    aa = sorted((x for x in internal if x["eligible"]), key=lambda x: x["id"])
    bb = sorted((x for x in external if x["eligible"]), key=lambda x: x["id"])
    all_edges = {
        (i, j): edge_value(a, b)
        for i, a in enumerate(aa)
        for j, b in enumerate(bb)
        if candidate(a, b, layer)
    }
    adj = {("I", i): set() for i in range(len(aa))}
    adj.update({("E", j): set() for j in range(len(bb))})
    for i, j in all_edges:
        adj[("I", i)].add(("E", j))
        adj[("E", j)].add(("I", i))
    seen = set()
    accepted = []
    amb_i = set()
    amb_e = set()
    proof = []
    for seed in sorted(adj):
        if seed in seen or not adj[seed]:
            continue
        todo = [seed]
        nodes = set()
        while todo:
            node = todo.pop()
            if node in nodes:
                continue
            nodes.add(node)
            todo.extend(adj[node] - nodes)
        seen.update(nodes)
        is_ = sorted(i for s, i in nodes if s == "I")
        js = sorted(j for s, j in nodes if s == "E")
        il = {i: k for k, i in enumerate(is_)}
        jl = {j: k for k, j in enumerate(js)}
        edges = {(il[i], jl[j]): v for (i, j), v in all_edges.items() if i in il and j in jl}
        optimum, chosen = solve_component(len(is_), len(js), edges)
        forced_pairs = []
        ambiguous_edges = []
        for pair in chosen:
            if solve_component(len(is_), len(js), edges, excluded=pair)[0] != optimum:
                forced_pairs.append(pair)
        forced_i = {i for i, _j in forced_pairs}
        forced_e = {j for _i, j in forced_pairs}
        for edge in edges:
            if edge in forced_pairs:
                continue
            if solve_component(len(is_), len(js), edges, forced=edge)[0] == optimum:
                ambiguous_edges.append(edge)
                i, j = edge
                if i not in forced_i:
                    amb_i.add(is_[i])
                if j not in forced_e:
                    amb_e.add(js[j])
        for i, j in forced_pairs:
            a, b = aa[is_[i]], bb[js[j]]
            geo = a["comparableGeometry"] == b["comparableGeometry"]
            same_support = a["startSupport"] == b["startSupport"] and a["endSupport"] == b["endSupport"]
            exact = (
                geo
                and same_support
                and a["commonAnchors"] == b["commonAnchors"]
                and (layer == "K" or a["direction"] == b["direction"])
            )
            cat = "EXACT_MATCH" if exact else ("TOLERANCE_MATCH" if geo else "GEOMETRY_DISAGREEMENT")
            accepted.append(
                dict(
                    internalId=a["id"],
                    externalId=b["id"],
                    category=cat,
                    directionEqual=a["direction"] == b["direction"],
                    geometryEqual=geo,
                    commonAnchorDisplacement=[y - x for x, y in zip(a["commonAnchors"], b["commonAnchors"])],
                    nativeEndRawIndexDisplacement=(
                        (b.get("geometricPeakRawIndex") - a["eventRawIndex"])
                        if layer == "F"
                        else b["endRawIndex"] - a["endRawIndex"]
                    ),
                    toleranceBasis="ACTUAL_SOURCE_SUPPORT_OVERLAP" if cat == "TOLERANCE_MATCH" else None,
                    forcedInAllOptimalAssignments=True,
                )
            )
        proof.append(
            dict(
                internalIds=[aa[i]["id"] for i in is_],
                externalIds=[bb[j]["id"] for j in js],
                objective=dict(
                    cardinality=optimum[0],
                    exactCommonAnchorPairs=optimum[1],
                    absoluteDisplacement=-optimum[2],
                ),
                candidateEdges=[
                    dict(
                        internalId=aa[is_[i]]["id"],
                        externalId=bb[js[j]]["id"],
                        exactAnchors=s,
                        absoluteDisplacement=d,
                    )
                    for (i, j), (s, d) in sorted(edges.items())
                ],
                forcedPairs=[(aa[is_[i]]["id"], bb[js[j]]["id"]) for i, j in forced_pairs],
                ambiguousOptimalEdges=[(aa[is_[i]]["id"], bb[js[j]]["id"]) for i, j in ambiguous_edges],
            )
        )
    matched_i = {x["internalId"] for x in accepted}
    matched_e = {x["externalId"] for x in accepted}
    ai = sorted(aa[i]["id"] for i in amb_i)
    ae = sorted(bb[j]["id"] for j in amb_e)
    ui = sorted(x["id"] for x in aa if x["id"] not in matched_i and x["id"] not in ai)
    ue = sorted(x["id"] for x in bb if x["id"] not in matched_e and x["id"] not in ae)
    return dict(
        layer=layer,
        pairs=sorted(accepted, key=lambda x: (x["internalId"], x["externalId"])),
        unmatchedInternal=ui,
        unmatchedExternal=ue,
        ambiguousInternal=ai,
        ambiguousExternal=ae,
        excludedInternal=sorted(
            [dict(id=x["id"], reason=x["exclusionReason"]) for x in internal if not x["eligible"]],
            key=lambda x: x["id"],
        ),
        excludedExternal=sorted(
            [dict(id=x["id"], reason=x["exclusionReason"]) for x in external if not x["eligible"]],
            key=lambda x: x["id"],
        ),
        components=proof,
    )


def distribution(values: list[float | int]) -> dict:
    if not values:
        return dict(n=0, mean=None, median=None, p90=None, max=None)
    return dict(
        n=len(values),
        mean=float(np.mean(values)),
        median=float(np.median(values)),
        p90=float(np.percentile(values, 90)),
        max=float(max(values)),
    )


def metrics(i: list[dict], e: list[dict], m: dict) -> dict:
    ni = sum(x["eligible"] for x in i)
    ne = sum(x["eligible"] for x in e)
    ps = m["pairs"]
    n = len(ps)
    c = Counter(p["category"] for p in ps)
    den = ni + ne
    return dict(
        layer=m["layer"],
        internalCount=ni,
        externalCount=ne,
        countDifference=ni - ne,
        countDifferenceDefinition="nI - nE",
        nativeInternalCount=len(i),
        nativeExternalCount=len(e),
        exactMatchCount=c["EXACT_MATCH"],
        toleranceMatchCount=c["TOLERANCE_MATCH"],
        geometryDisagreementCount=c["GEOMETRY_DISAGREEMENT"],
        acceptedCorrespondenceCount=n,
        unmatchedInternalCount=len(m["unmatchedInternal"]),
        unmatchedExternalCount=len(m["unmatchedExternal"]),
        ambiguousInternalCount=len(m["ambiguousInternal"]),
        ambiguousExternalCount=len(m["ambiguousExternal"]),
        matchedStructureRatio=2 * n / den if den else None,
        exactStructureRatio=2 * c["EXACT_MATCH"] / den if den else None,
        matchedInternalCoverage=n / ni if ni else None,
        matchedExternalCoverage=n / ne if ne else None,
        unmatchedInternalRatio=len(m["unmatchedInternal"]) / ni if ni else None,
        unmatchedExternalRatio=len(m["unmatchedExternal"]) / ne if ne else None,
        ambiguousInternalCoverage=len(m["ambiguousInternal"]) / ni if ni else None,
        ambiguousExternalCoverage=len(m["ambiguousExternal"]) / ne if ne else None,
        conditionalExactMatchRatio=c["EXACT_MATCH"] / n if n else None,
        toleranceMatchRatio=2 * c["TOLERANCE_MATCH"] / den if den else None,
        geometryDisagreementRatio=2 * c["GEOMETRY_DISAGREEMENT"] / den if den else None,
        directionAgreement=sum(p["directionEqual"] for p in ps) / n if n else None,
        directionAgreementInterpretation=(
            "conditional matching constraint, not independent validation"
            if m["layer"] != "K"
            else "measured; K direction not used to select pairs"
        ),
        endpointDisplacement=distribution([abs(p["commonAnchorDisplacement"][1]) for p in ps]),
        startEndpointDisplacement=distribution([abs(p["commonAnchorDisplacement"][0]) for p in ps]),
        eventLocationDisplacement=distribution([abs(p["commonAnchorDisplacement"][2]) for p in ps]),
        nativeEndpointIndexDisplacement=distribution([abs(p["nativeEndRawIndexDisplacement"]) for p in ps]),
        displacementBasis="common source-support end; native extrema indices reported separately and not equivalent event clocks",
        notComparableInternal=sum((not x["eligible"]) and x["exclusionReason"].startswith("NOT_COMPARABLE") for x in i),
        notComparableExternal=sum((not x["eligible"]) and x["exclusionReason"].startswith("NOT_COMPARABLE") for x in e),
        externalUnsureExcludedCount=sum(not x["eligible"] for x in e),
        notComparableCoverage=dict(
            confirmationTime=1.0 if len(i) + len(e) else None,
            lifecycle=1.0 if len(i) + len(e) else None,
            missingSupportInternal=sum(not x["eligible"] for x in i) / len(i) if i else None,
            missingSupportExternal=(
                sum((not x["eligible"]) and x["exclusionReason"].startswith("NOT_COMPARABLE") for x in e) / len(e)
                if e
                else None
            ),
        ),
        confirmationTimeDifference=None,
        confirmationTimeStatus="NOT_COMPARABLE",
        lifecycleStatus="NOT_COMPARABLE",
        zeroDenominatorStatus="NOT_OBSERVED" if not den else "OBSERVED",
    )


def small_checks() -> int:
    """Exhaustive brute-force verification of solve_component (32 synthetic cases)."""
    def brute(n, m, edges):
        options = []

        def visit(i, used, chosen):
            if i == n:
                options.append(
                    (
                        (
                            len(chosen),
                            sum(edges[x][0] for x in chosen),
                            -sum(edges[x][1] for x in chosen),
                        ),
                        frozenset(chosen),
                    )
                )
                return
            visit(i + 1, used, chosen)
            for j in range(m):
                if j not in used and (i, j) in edges:
                    visit(i + 1, used | {j}, chosen + [(i, j)])

        visit(0, set(), [])
        opt = max(o for o, _s in options)
        solutions = [s for o, s in options if o == opt]
        return opt, set.intersection(*(set(s) for s in solutions))

    cases = [
        dict(name="non-greedy-trap", n=2, m=2, edges={(0, 0): (1, 0), (0, 1): (0, 2), (1, 0): (0, 2)}),
        dict(name="all-optima-ambiguity", n=2, m=2, edges={(i, j): (1, 0) for i in range(2) for j in range(2)}),
    ]
    rng = random.Random(20261009)
    for k in range(30):
        cases.append(
            dict(
                name=f"brute-{k}",
                n=3,
                m=3,
                edges={
                    (i, j): (rng.randrange(2), rng.randrange(8))
                    for i in range(3)
                    for j in range(3)
                    if rng.random() < 0.6
                },
            )
        )
    for c in cases:
        opt, forced = brute(c["n"], c["m"], c["edges"])
        actual, ch = solve_component(c["n"], c["m"], c["edges"])
        found = {edge for edge in ch if solve_component(c["n"], c["m"], c["edges"], excluded=edge)[0] != actual}
        if actual != opt or found != forced:
            raise ValueError(f"ASSIGNMENT_BRUTE_FORCE_CHECK failed on {c['name']}")
    return len(cases)


if __name__ == "__main__":
    n_ok = small_checks()
    print(f"[PASS] R7 matching brute-force self-checks: {n_ok}/{n_ok}")
