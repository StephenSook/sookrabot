#!/usr/bin/env python3
"""Merge self-play result files and print per-variant results with paired differences.

Usage:
  python3 bot-starter/scripts/selfplay_aggregate.py PATH... [--expect=N] [--baseline=VARIANT]
                                                    [--format=text|markdown|json]

PATH is a rows file (.jsonl) or a directory, searched recursively for .jsonl files (the
layout `gh run download` writes). Standard library only.

Two kinds of lines are understood:

compare rows (selfplay.ts compare --rows=FILE, one line per variant and match). Rows are
grouped by field and seed. Within a group, a row repeated with identical results is
dropped (a re-run shard), a repeated row with different results is an error, and rows
from different code (the hash of the bot, harness, rival and wordlist sources) are an
error. With --expect=N every variant must cover exactly matches 0 to N-1. Every variant
must cover the same matches, since the differences are paired by match. Per variant:
mean score with its standard error, win rate (top score, ties included), last-place
rate (bottom score, ties included), mean placement (1 + rivals with a strictly higher
score, as Swiss points count places), mean margin over the best rival, and against
the baseline (the first variant listed, or --baseline) the paired difference of score,
placement, win, last and margin: mean, standard error and t = mean / se over matches.
"identical" counts matches where the variant's whole row equals the baseline's.

validate4 lines (selfplay.ts validate4, one line per rival): grouped by entries, seed
and matches, one column per rho, simulated score and place beside the live numbers.
validate5 lines (selfplay.ts validate5): the same, one column per configuration (rho and
rival modifiers), with letters won, 7+ words, the pack value of the letters won and coins
paid too, and the mean and largest absolute error over the top rivals (marked *).
calibrate5 lines (selfplay.ts calibrate5, one per round of a bid-scale fit): the errors round
by round and the scales after the last round.

Exit status: 0 on success, 1 when the rows are incomplete, inconsistent or missing
(no rows at all is an error, not an empty result), 2 on a usage error.
"""

import json
import math
import os
import sys

COMPARE_KEYS = ("variant", "i", "field", "seed", "code", "score", "best", "win", "last", "swiss", "seats", "others")


class InputError(Exception):
    pass


def parse_args(argv):
    opts = {"expect": None, "baseline": None, "format": "text"}
    paths = []
    for a in argv:
        if a.startswith("--expect="):
            v = a.split("=", 1)[1]
            if not v.isdigit() or int(v) <= 0:
                raise SystemExit(usage(f"--expect wants a whole number > 0, got {v!r}"))
            opts["expect"] = int(v)
        elif a.startswith("--baseline="):
            opts["baseline"] = a.split("=", 1)[1]
        elif a.startswith("--format="):
            v = a.split("=", 1)[1]
            if v not in ("text", "markdown", "json"):
                raise SystemExit(usage(f"--format is text, markdown or json, got {v!r}"))
            opts["format"] = v
        elif a in ("-h", "--help"):
            print(__doc__)
            raise SystemExit(0)
        elif a.startswith("--"):
            raise SystemExit(usage(f"unknown option {a}"))
        else:
            paths.append(a)
    if not paths:
        raise SystemExit(usage("name at least one rows file or directory"))
    return paths, opts


def usage(msg):
    sys.stderr.write(f"selfplay_aggregate: {msg}\n(see --help)\n")
    return 2


def find_files(paths):
    files = []
    for p in paths:
        if os.path.isdir(p):
            for root, _dirs, names in os.walk(p):
                files.extend(os.path.join(root, n) for n in names if n.endswith(".jsonl"))
        elif os.path.isfile(p):
            files.append(p)
        else:
            raise InputError(f"{p}: no such file or directory")
    return sorted(set(files))


def read_lines(files):
    compare_rows, validate_rows = [], []
    for f in files:
        with open(f, encoding="utf-8") as fh:
            for ln, line in enumerate(fh, 1):
                if not line.strip():
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    raise InputError(f"{f}:{ln}: not JSON (a truncated last line means the run was cut off)")
                if not isinstance(r, dict):
                    raise InputError(f"{f}:{ln}: not a JSON object")
                if r.get("kind") in ("validate4", "validate5", "calibrate5"):
                    validate_rows.append(r)
                    continue
                missing = [k for k in COMPARE_KEYS if k not in r]
                if missing or not isinstance(r["i"], int) or not isinstance(r["variant"], str):
                    raise InputError(f"{f}:{ln}: not a self-play row (missing {', '.join(missing) or 'types'})")
                r["_where"] = f"{f}:{ln}"
                compare_rows.append(r)
    return compare_rows, validate_rows


def content(r):
    """A row's results: everything but the wall time and where it was read from."""
    return json.dumps({k: v for k, v in r.items() if k not in ("ms", "_where")}, sort_keys=True)


def group_compare(rows):
    groups = {}
    for r in rows:
        g = groups.setdefault((r["field"], r["seed"]), {"order": [], "rows": {}})
        key = (r["variant"], r["i"])
        had = g["rows"].get(key)
        if had is not None:
            if content(had) != content(r):
                raise InputError(f"{r['_where']}: variant {r['variant']} match {r['i']} of {r['field']} seed {r['seed']} "
                                 f"differs from {had['_where']}")
            continue
        g["rows"][key] = r
        if r["variant"] not in g["order"]:
            g["order"].append(r["variant"])
    return groups


def mean_se(xs):
    n = len(xs)
    m = sum(xs) / n
    if n < 2:
        return m, float("nan")
    var = sum((x - m) ** 2 for x in xs) / (n - 1)
    return m, math.sqrt(var / n)


def paired(xs):
    m, se = mean_se(xs)
    if se != se or se == 0:  # nan (one match) or every difference equal
        return {"mean": m, "se": se if se == se else None, "t": None}
    return {"mean": m, "se": se, "t": m / se}


def placement(r):
    return r["seats"] - r["swiss"] + 1


METRICS = {
    "score": lambda r: r["score"],
    "place": placement,
    "win": lambda r: r["win"],
    "last": lambda r: r["last"],
    "margin": lambda r: r["score"] - r["best"],
}


def summarize_group(field, seed, g, opts):
    order = g["order"]
    by_variant = {v: {} for v in order}
    for (v, i), r in g["rows"].items():
        by_variant[v][i] = r
    codes = {r["code"] for r in g["rows"].values()}
    if len(codes) > 1:
        raise InputError(f"{field} seed {seed}: rows from different code ({', '.join(sorted(codes))})")
    expect = opts["expect"]
    for v in order:
        ids = set(by_variant[v])
        if expect is not None:
            missing = [i for i in range(expect) if i not in ids]
            extra = sorted(i for i in ids if i >= expect or i < 0)
            if missing or extra:
                raise InputError(f"{field} seed {seed} {v}: {len(missing)} of {expect} matches missing "
                                 f"(first {missing[:5]}), {len(extra)} outside 0..{expect - 1}")
    base = opts["baseline"] or order[0]
    if base not in by_variant:
        raise InputError(f"{field} seed {seed}: baseline {base} not among {order}")
    ids = sorted(by_variant[base])
    for v in order:
        if sorted(by_variant[v]) != ids:
            raise InputError(f"{field} seed {seed}: {v} and {base} cover different matches; paired differences need the same ones")
    any_row = by_variant[base][ids[0]]
    out = []
    for v in order:
        rs = [by_variant[v][i] for i in ids]
        bs = [by_variant[base][i] for i in ids]
        s = {
            "field": field, "seed": seed, "auction": any_row.get("auction"), "seats": any_row["seats"],
            "code": any_row["code"], "variant": v, "n": len(rs), "baseline": base,
        }
        for name, f in METRICS.items():
            m, se = mean_se([f(r) for r in rs])
            s[name] = {"mean": m, "se": se if se == se else None}
        if v != base:
            s["vsBaseline"] = {name: paired([f(a) - f(b) for a, b in zip(rs, bs)]) for name, f in METRICS.items()}
            s["vsBaseline"]["identical"] = sum(content({**a, "variant": "", "code": ""}) == content({**b, "variant": "", "code": ""})
                                               for a, b in zip(rs, bs))
        s["msPerMatch"] = round(sum(r.get("ms", 0) for r in rs) / len(rs))
        rivals = {}
        for r in rs:
            for o in r["others"]:
                key = "sims" if o.get("kind") == "sim" else o["name"]
                acc = rivals.setdefault(key, [0.0, 0])
                acc[0] += o["score"]
                acc[1] += 1
        s["rivalScore"] = {k: round(a[0] / a[1], 1) for k, a in rivals.items()}
        out.append(s)
    return out


def fmt(x, digits=2, sign=False):
    if x is None or (isinstance(x, float) and x != x):
        return "-"
    return f"{x:+.{digits}f}" if sign else f"{x:.{digits}f}"


def baseline_of(summaries):
    return next(s for s in summaries if s["variant"] == s["baseline"])


def render_compare_text(summaries):
    s0 = baseline_of(summaries)
    lines = [f"{s0['field']} seed {s0['seed']}: {s0['auction']}, {s0['seats']} seats, {s0['n']} matches per variant, "
             f"code {s0['code']}, baseline {s0['baseline']}"]
    width = max(len(s["variant"]) for s in summaries)
    for s in summaries:
        lines.append(
            f"  {s['variant']:<{width}}  score {fmt(s['score']['mean']):>7} (se {fmt(s['score']['se'])})"
            f"  win {fmt(100 * s['win']['mean'], 1):>5}%  last {fmt(100 * s['last']['mean'], 1):>5}%"
            f"  place {fmt(s['place']['mean'])}  margin {fmt(s['margin']['mean'], 1, True)}  {s['msPerMatch']} ms/match")
        d = s.get("vsBaseline")
        if d:
            lines.append(
                f"  {'':<{width}}  vs {s['baseline']}: score {fmt(d['score']['mean'], 2, True)}"
                f" (se {fmt(d['score']['se'])}, t {fmt(d['score']['t'])})"
                f"  place {fmt(d['place']['mean'], 3, True)} (t {fmt(d['place']['t'])})"
                f"  win {fmt(100 * d['win']['mean'], 1, True)} pts (t {fmt(d['win']['t'])})"
                f"  last {fmt(100 * d['last']['mean'], 1, True)} pts (t {fmt(d['last']['t'])})"
                f"  identical {d['identical']}/{s['n']}")
    lines.append("  rivals' mean score (baseline): " +
                 ", ".join(f"{k} {v}" for k, v in sorted(s0["rivalScore"].items(), key=lambda kv: -kv[1])))
    return "\n".join(lines)


def render_compare_markdown(summaries):
    s0 = baseline_of(summaries)
    out = [f"### {s0['field']}, seed {s0['seed']}",
           f"{s0['auction']}, {s0['seats']} seats, {s0['n']} matches per variant, code `{s0['code']}`, "
           f"baseline `{s0['baseline']}`. Paired differences are variant minus baseline, match by match.",
           "",
           "| variant | score (se) | win % | last % | mean place | d score (se) | t | d place | t | d win pts | t | d last pts | t | identical |",
           "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for s in summaries:
        d = s.get("vsBaseline")
        cells = [f"`{s['variant']}`", f"{fmt(s['score']['mean'])} ({fmt(s['score']['se'])})",
                 fmt(100 * s["win"]["mean"], 1), fmt(100 * s["last"]["mean"], 1), fmt(s["place"]["mean"])]
        if d:
            cells += [f"{fmt(d['score']['mean'], 2, True)} ({fmt(d['score']['se'])})", fmt(d["score"]["t"]),
                      fmt(d["place"]["mean"], 3, True), fmt(d["place"]["t"]),
                      fmt(100 * d["win"]["mean"], 1, True), fmt(d["win"]["t"]),
                      fmt(100 * d["last"]["mean"], 1, True), fmt(d["last"]["t"]), f"{d['identical']}/{s['n']}"]
        else:
            cells += ["baseline", "", "", "", "", "", "", "", ""]
        out.append("| " + " | ".join(cells) + " |")
    out.append("")
    out.append("Rivals' mean score (baseline): " +
               ", ".join(f"{k} {v}" for k, v in sorted(s0["rivalScore"].items(), key=lambda kv: -kv[1])))
    return "\n".join(out)


def validate_groups(rows):
    groups = {}
    for r in rows:
        key = (r.get("kind"), r.get("entries"), r.get("seed"), r.get("matches"))
        if r.get("kind") == "validate5":
            label = r.get("label") or "fitted"
        else:
            label = "fitted" if r.get("rhoFitted") else f"rho {r.get('rho')}"
        # validate5 names rivals by stem, so columns of different entries (v5, v5c, v5k) line up
        name = r.get("stem", r["rival"])
        groups.setdefault(key, {}).setdefault(label, {})[name] = r
    return groups


# validate5 tables: (metric, digits); the mean absolute error is printed for the top rivals and for all.
V5_METRICS = (("score", 1), ("place", 2), ("won", 1), ("sevens", 2), ("pack_won", 1), ("paid", 1))


def render_fit(rows, markdown):
    """calibrate5 lines: per fit (base entries, modifiers, gamma), the errors round by round and the final scales."""
    out = []
    fits = {}
    for r in rows:
        # round r plays seed + 1000 r: the fit's own seed keeps separate fits apart
        seed0 = r.get("seed", 0) - 1000 * r.get("round", 0)
        fits.setdefault((r.get("base"), r.get("mods"), r.get("gamma"), r.get("update", "ratio"), r.get("matches"), seed0),
                        []).append(r)
    for (base, mods, gamma, update, matches, seed0), rs in sorted(fits.items(), key=lambda kv: str(kv[0])):
        rs.sort(key=lambda r: r["round"])
        title = (f"calibrate5 {base} entries{' +' + mods if mods else ''}, gamma {gamma}, {update} update, seed {seed0}, "
                 f"{matches} matches a round: per-rival bid scales fitted so the replayed live tables give each rival "
                 "its live score")
        head = ["round", "seed", "mean abs top", "max abs top", "mean abs all"]
        table = [[str(r["round"]), str(r["seed"]), fmt(r["meanAbsTop"], 1), fmt(r["maxAbsTop"], 1), fmt(r["meanAbsAll"], 1)]
                 for r in rs]
        last = rs[-1]
        scales = ", ".join(f"{k} {v}" for k, v in sorted(last["next"].items()))
        errs = ", ".join(f"{k} {v:+.1f}" for k, v in sorted(last["simMinusLive"].items(), key=lambda kv: -abs(kv[1])))
        if markdown:
            out += [f"### {title}", "", "| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
            out += ["| " + " | ".join(row) + " |" for row in table]
            out += ["", f"Last round sim minus live: {errs}", "", f"Scales after the last round: {scales}", ""]
        else:
            widths = [max(len(x[c]) for x in [head] + table) for c in range(len(head))]
            out.append(title)
            for row in [head] + table:
                out.append("  " + "  ".join(x.rjust(w) for x, w in zip(row, widths)))
            out.append(f"  last round sim minus live: {errs}")
            out.append(f"  scales after the last round: {scales}")
            out.append("")
    return "\n".join(out).rstrip()


def render_validate(rows, markdown):
    out = []
    fit = [r for r in rows if r.get("kind") == "calibrate5"]
    rows = [r for r in rows if r.get("kind") != "calibrate5"]
    if fit:
        out.append(render_fit(fit, markdown))
        out.append("")
    for (kind, entries, seed, matches), by_rho in sorted(validate_groups(rows).items(), key=lambda kv: str(kv[0])):
        labels = sorted(by_rho, key=lambda l: (l != "fitted", l))
        rivals = sorted({name for g in by_rho.values() for name in g},
                        key=lambda n: next((g[n]["live"] or {}).get("place", 9) for g in by_rho.values() if n in g))
        v5 = kind == "validate5"
        top = {n for g in by_rho.values() for n, r in g.items() if r.get("top")}
        if v5:
            title = f"validate5 {entries} entries, seed {seed}, {matches} matches (live all-real tables m1000 on replayed)"
        else:
            title = f"validate4 {entries} entries, seed {seed}, {matches} matches (rivals only, six to a table)"
        for metric, digits in (V5_METRICS if v5 else (("score", 1), ("place", 2))):
            head = ["rival", f"live {metric}"] + [f"sim {metric} ({l})" for l in labels]
            table = []
            err = {l: [] for l in labels}
            err_top = {l: [] for l in labels}
            for name in rivals:
                live = next((g[name]["live"] for g in by_rho.values() if name in g and g[name]["live"]), None)
                row = [name + (" *" if name in top else ""), fmt(live.get(metric), digits) if live else "-"]
                for l in labels:
                    r = by_rho[l].get(name)
                    if r is None:
                        row.append("-")
                        continue
                    row.append(fmt(r["sim"][metric], digits))
                    if live and live.get(metric) is not None:
                        err[l].append(abs(r["sim"][metric] - live[metric]))
                        if name in top:
                            err_top[l].append(abs(r["sim"][metric] - live[metric]))
                table.append(row)
            if top:
                table.append(["mean abs(sim - live), top *", ""] +
                             [fmt(sum(e) / len(e), digits) if e else "-" for e in err_top.values()])
                table.append(["max abs(sim - live), top *", ""] + [fmt(max(e), digits) if e else "-" for e in err_top.values()])
            table.append(["mean abs(sim - live)", ""] + [fmt(sum(e) / len(e), digits) if e else "-" for e in err.values()])
            if markdown:
                out += [f"### {title}: {metric}", "", "| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
                out += ["| " + " | ".join(r) + " |" for r in table]
                out.append("")
            else:
                widths = [max(len(str(r[c])) for r in [head] + table) for c in range(len(head))]
                out.append(f"{title}: {metric}")
                for r in [head] + table:
                    out.append("  " + "  ".join(str(x).rjust(w) if c else str(x).ljust(w) for c, (x, w) in enumerate(zip(r, widths))))
                out.append("")
    return "\n".join(out).rstrip()


def main(argv):
    paths, opts = parse_args(argv)
    try:
        files = find_files(paths)
        if not files:
            raise InputError("no .jsonl files under " + ", ".join(paths))
        compare_rows, validate_rows = read_lines(files)
        if not compare_rows and not validate_rows:
            raise InputError(f"no rows in {len(files)} file(s): nothing ran, or the wrong path")
        results = []
        for (field, seed), g in sorted(group_compare(compare_rows).items(), key=lambda kv: (kv[0][0], kv[0][1])):
            results.append(summarize_group(field, seed, g, opts))
    except InputError as e:
        sys.stderr.write(f"selfplay_aggregate: {e}\n")
        return 1
    fmt_name = opts["format"]
    if fmt_name == "json":
        for summaries in results:
            for s in summaries:
                print(json.dumps(s))
        for r in validate_rows:
            print(json.dumps(r))
        return 0
    blocks = []
    for summaries in results:
        blocks.append(render_compare_markdown(summaries) if fmt_name == "markdown" else render_compare_text(summaries))
    if validate_rows:
        blocks.append(render_validate(validate_rows, fmt_name == "markdown"))
    print("\n\n".join(blocks))
    sys.stderr.write(f"selfplay_aggregate: {len(files)} file(s), {len(compare_rows)} compare rows, "
                     f"{len(validate_rows)} validate lines\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
