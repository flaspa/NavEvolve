"""python eval/report.py eval/results/*.json  -> eval/report.html"""
import html, json, sys
from pathlib import Path

COL = {"kept": "#2a7", "wiped": "#c52"}


def mean(v):
    v = [x for x in v if x is not None]
    return sum(v) / len(v) if v else 0


def chart(runs):
    W, H, P = 560, 240, 36
    mx = max([r["steps"] for d in runs for r in d["episodes"]] + [1])
    n = max([len(d["episodes"]) for d in runs] + [2])
    X = lambda i: P + (W - 2 * P) * i / (n - 1)
    Y = lambda v: H - P - (H - 2 * P) * v / mx
    s = [f'<svg width="{W}" height="{H}" style="background:#fff;border:1px solid #ddd">',
         f'<line x1="{P}" y1="{H-P}" x2="{W-P}" y2="{H-P}" stroke="#888"/><line x1="{P}" y1="{P}" x2="{P}" y2="{H-P}" stroke="#888"/>',
         f'<text x="{P}" y="{H-8}" font-size="11">goal index</text><text x="4" y="{P-8}" font-size="11">steps (max {mx})</text>']
    for k, d in enumerate(runs):
        c = COL.get(d["mode"], "#46a")
        pts = " ".join(f"{X(r['index']):.1f},{Y(r['steps']):.1f}" for r in d["episodes"])
        s.append(f'<polyline points="{pts}" fill="none" stroke="{c}" stroke-width="2"/>')
        s.append(f'<text x="{W-P-70}" y="{P+14*k}" font-size="12" fill="{c}">{html.escape(d["mode"])}</text>')
    return "".join(s) + "</svg>"


def build(paths, out):
    runs = [json.load(open(p)) for p in paths]
    h = ["<html><body style='font:14px sans-serif;max-width:900px;margin:20px auto'><h1>NavEvolve ObjectNav</h1>",
         "<table border=1 cellpadding=4 style='border-collapse:collapse'><tr><th>mode<th>scene<th>n<th>success<th>steps<th>metres<th>seconds<th>% recall</tr>"]
    for d in runs:
        e = d["episodes"]
        h.append(f"<tr><td>{d['mode']}<td>{d['scene']}<td>{len(e)}<td>{mean([r['success'] for r in e]):.0%}"
                 f"<td>{mean([r['steps'] for r in e]):.1f}<td>{mean([r['metres'] for r in e]):.1f}"
                 f"<td>{mean([r['seconds'] for r in e]):.1f}<td>{mean([r['mode'] == 'recall' for r in e]):.0%}</tr>")
    h.append("</table><h2>Steps per goal index</h2>" + chart(runs))
    for d in runs:
        h.append(f"<h2>{d['mode']}</h2><table border=1 cellpadding=4 style='border-collapse:collapse'>")
        for r in d["episodes"]:
            th = "<br>".join(html.escape(str(t)) for t in r.get("thoughts", []))
            h.append(f"<tr><td>{r['index']}<td>{html.escape(r['goal'])}<td>{r['mode']}<td>{'OK' if r['success'] else 'FAIL'}"
                     f"<td>{r['steps']} steps<td><details><summary>thoughts</summary>{th}</details></tr>")
        h.append("</table>")
    Path(out).write_text("".join(h) + "</body></html>")


if __name__ == "__main__":
    build(sys.argv[1:], Path(__file__).parent / "report.html")
