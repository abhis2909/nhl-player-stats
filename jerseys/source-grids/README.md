# Source grids

Drop the raw "Top 20 All-Time Players" grid images here — one file per
team — so Claude can pull them from the repo and slice them into
individual jersey PNGs (see the main `jerseys/README.md` for how those
per-player files get published and wired into `jersey-art.js`).

Name each file by team abbreviation so it maps to a team unambiguously:

```
ana.png  bos.png  buf.png  cgy.png  car.png  chi.png  col.png  cbj.png
dal.png  det.png  edm.png  fla.png  lak.png  min.png  mtl.png  nsh.png
njd.png  nyi.png  nyr.png  ott.png  phi.png  pit.png  sjs.png  sea.png
stl.png  tbl.png  tor.png  van.png  vgk.png  wsh.png  wpg.png
```

(31 files — every team except Utah.) Any image extension is fine
(`.png`, `.jpg`, …), just keep the team abbreviation as the filename
stem. These are working files, not published jersey art — nothing in
this folder is served to players; the per-player crops that come out
of them land in `jerseys/` itself, next to this folder.
