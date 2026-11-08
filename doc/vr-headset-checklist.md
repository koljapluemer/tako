# VR headset checklist

Things only a real Quest can confirm. Fill this in as you test; results replace
the provisional constants named below.

## Setup

1. `just corpus` builds the test models in `viewer/.corpus/` (not committed).
2. `just vr` serves over HTTPS on the LAN. Open `https://<lan-ip>:5173/?hud=1` in
   Quest Browser and accept the certificate warning.
3. Corpus models appear in the building list with the prefix `Corpus:`.
4. The readout shows frame time, draw calls, triangles, heap and disk use.

## Budgets (step 1)

| Model | Frame avg / worst (ms) | Draw calls | Triangles | Heap | Disk | Load time |
|---|---|---|---|---|---|---|
| corpus: synthetic/no-spaces | | | | | | |
| corpus: synthetic/large | | | | | | |
| corpus: real/s-office-archi | | | | | | |

Agreed budget: _not measured yet_.

Also record the storage quota Quest Browser reports (open question in the plan).
