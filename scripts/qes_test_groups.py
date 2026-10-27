#!/usr/bin/env python3
"""Rozdělí spec soubory do N skupin pro paralelní RSpec (docs/21 § 8, fáze 3).

Vstup: seznam spec souborů (jeden na řádek) v souboru nebo na stdin.
Časy bere z `test/qes/timings.txt` (`<sekundy>\\t<cesta>`); soubor, který tam
není, dostane medián známých časů (konzervativní odhad).

Soubory dražší než `--split-threshold` rozbalí na jednotlivé example
(`cesta:řádek`) — RSpec jinak běží celý soubor v jednom workeru a ten pak
drží podlahu celého běhu (`spec/system/signing_form_spec.rb` = 133 s).

Dělení je LPT (longest processing time first): nejdražší položka jde vždy do
nejprázdnějšího koše. Round-robin podle počtu souborů dá jen 1,15× zrychlení,
LPT podle časů ~2×.

Výstup: jeden řádek na workera, položky oddělené mezerou (pro `xargs`/`mapfile`).
"""

import argparse
import os
import re
import statistics
import sys

# `it` / `specify` / `example` na začátku řádku (libovolné odsazení).
# Loop-generated examples (`[...].each do |x| it "..."`) sdílí jeden řádek —
# `cesta:řádek` pak vybere všechny iterace, což je správně.
EXAMPLE_RE = re.compile(r'^\s+(?:it|specify|example)\s+[\'"]')


def load_timings(path):
    timings = {}
    if not os.path.exists(path):
        print(f'# timings: {path} neexistuje, používám medián', file=sys.stderr)
        return timings
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            try:
                timings[parts[1]] = float(parts[0])
            except ValueError:
                continue
    return timings


def example_lines(path):
    lines = []
    try:
        with open(path, errors='replace') as handle:
            for number, text in enumerate(handle, 1):
                if EXAMPLE_RE.match(text):
                    lines.append(number)
    except OSError:
        pass
    return lines


def entries_for(spec, weight, repo, threshold):
    """Vrátí [(název, váha)] — buď celý soubor, nebo jeho examples."""
    if weight <= threshold:
        return [(spec, weight)]

    lines = example_lines(os.path.join(repo, spec))
    if len(lines) < 2:
        return [(spec, weight)]

    per_example = weight / len(lines)
    return [(f'{spec}:{line}', per_example) for line in lines]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timings', required=True)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--split-threshold', type=float, default=45.0)
    parser.add_argument('--repo', default='vendor/docuseal')
    parser.add_argument('list', help='soubor se seznamem spec souborů (jeden na řádek)')
    args = parser.parse_args()

    if args.workers < 1:
        parser.error('--workers musí být >= 1')

    timings = load_timings(args.timings)
    with open(args.list) as handle:
        specs = [line.strip() for line in handle if line.strip()]

    fallback = statistics.median(timings.values()) if timings else 1.0
    entries = []
    for spec in specs:
        weight = timings.get(spec, fallback)
        entries.extend(entries_for(spec, weight, args.repo, args.split_threshold))

    # LPT: nejdražší napřed, každá položka do aktuálně nejprázdnějšího koše.
    entries.sort(key=lambda item: item[1], reverse=True)
    bins = [[] for _ in range(args.workers)]
    loads = [0.0] * args.workers
    for name, weight in entries:
        index = loads.index(min(loads))
        bins[index].append(name)
        loads[index] += weight

    for items, load in zip(bins, loads):
        print(' '.join(items))
        print(f'# worker: {len(items)} položek, odhad {load:.0f} s', file=sys.stderr)


if __name__ == '__main__':
    main()
