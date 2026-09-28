"""L13 ML prioritiser: LightGBM lambdarank on E6 hide-and-recover labels (and E8 ratings when
they exist), trained and evaluated with site-grouped cross-validation, explained with TreeSHAP.

The TypeScript side writes the dataset (`pnpm --filter @linklens/eval l13 export`) and imports
the per-site predictions back as `learned-priority` artefacts (`l13 import`), which the API
serves as the scoring mode "learned". S stays the default.

    python -m ml train  <batch>/l13/dataset --out <batch>/l13/model
    python -m ml report <batch>/l13/model  (after `l13 import`, which adds e3.csv)
"""
