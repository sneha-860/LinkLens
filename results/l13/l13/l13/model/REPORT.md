# L13 learned prioritiser

Cross-validation: leave-one-site-out (9 sites).

## E6 recovery per held-out site

|                                |    auc |     mrr |   queries |   recall@10 |   recall@20 |   recall@5 |
|:-------------------------------|-------:|--------:|----------:|------------:|------------:|-----------:|
| ('books-toscrape', 'S')        | 0.5494 | 0.05459 |       189 |     0.1181  |     0.1363  |    0.09833 |
| ('books-toscrape', 'hybrid')   | 0.5497 | 0.08104 |       189 |     0.1181  |     0.1363  |    0.1089  |
| ('books-toscrape', 'learned')  | 0.9823 | 0.7502  |       189 |     0.8466  |     0.8995  |    0.8201  |
| ('css-tricks', 'S')            | 0.6212 | 0.07036 |      1330 |     0.1013  |     0.1457  |    0.0791  |
| ('css-tricks', 'hybrid')       | 0.6273 | 0.09664 |      1330 |     0.1306  |     0.1825  |    0.1032  |
| ('css-tricks', 'learned')      | 0.6997 | 0.1547  |      1330 |     0.2594  |     0.3023  |    0.2105  |
| ('flask', 'S')                 | 0.6212 | 0.1575  |       102 |     0.3908  |     0.5123  |    0.3272  |
| ('flask', 'hybrid')            | 0.625  | 0.2479  |       102 |     0.381   |     0.5123  |    0.3272  |
| ('flask', 'learned')           | 0.855  | 0.4289  |       102 |     0.6569  |     0.7843  |    0.5392  |
| ('julia-evans', 'S')           | 0.5897 | 0.1736  |       252 |     0.2242  |     0.2479  |    0.2087  |
| ('julia-evans', 'hybrid')      | 0.5895 | 0.1602  |       252 |     0.2242  |     0.2479  |    0.2048  |
| ('julia-evans', 'learned')     | 0.9525 | 0.6826  |       252 |     0.7619  |     0.8095  |    0.7421  |
| ('scrapeme-live', 'S')         | 0.4322 | 0.0298  |       320 |     0.04133 |     0.07653 |    0.02373 |
| ('scrapeme-live', 'hybrid')    | 0.4234 | 0.02953 |       320 |     0.04133 |     0.07653 |    0.02373 |
| ('scrapeme-live', 'learned')   | 0.6575 | 0.16    |       320 |     0.2812  |     0.3469  |    0.2156  |
| ('simon-willison', 'S')        | 0.7048 | 0.2851  |      3009 |     0.4272  |     0.4799  |    0.374   |
| ('simon-willison', 'hybrid')   | 0.7054 | 0.2932  |      3009 |     0.4282  |     0.4779  |    0.3686  |
| ('simon-willison', 'learned')  | 0.8233 | 0.3091  |      3009 |     0.4364  |     0.5567  |    0.3669  |
| ('vite', 'S')                  | 0.6813 | 0.4622  |        89 |     0.6164  |     0.7935  |    0.5278  |
| ('vite', 'hybrid')             | 0.6808 | 0.4631  |        89 |     0.6164  |     0.7935  |    0.5278  |
| ('vite', 'learned')            | 0.8431 | 0.5224  |        89 |     0.8315  |     0.9213  |    0.7303  |
| ('webscraper-test', 'S')       | 0.7262 | 0.3877  |       791 |     0.5159  |     0.5646  |    0.4768  |
| ('webscraper-test', 'hybrid')  | 0.7277 | 0.4314  |       791 |     0.526   |     0.5836  |    0.4755  |
| ('webscraper-test', 'learned') | 0.762  | 0.3381  |       791 |     0.3919  |     0.4564  |    0.3515  |

## Learned vs S across sites (E6)

| metric    |   sites |   mean learned |   mean S |   mean difference | wins/ties/losses   |   p (a > b) |   p (two-sided) |   r (rank-biserial) |   p_holm (two-sided) |
|:----------|--------:|---------------:|---------:|------------------:|:-------------------|------------:|----------------:|--------------------:|---------------------:|
| auc       |       8 |         0.8219 |   0.6157 |            0.2062 | 8/0/0              |    0.003906 |        0.007812 |              1      |              0.03906 |
| mrr       |       8 |         0.4182 |   0.2026 |            0.2156 | 7/0/1              |    0.01172  |        0.02344  |              0.8889 |              0.09375 |
| recall@10 |       8 |         0.5582 |   0.3044 |            0.2538 | 7/0/1              |    0.01172  |        0.02344  |              0.8889 |              0.09375 |
| recall@20 |       8 |         0.6346 |   0.3696 |            0.265  | 7/0/1              |    0.01172  |        0.02344  |              0.8889 |              0.09375 |
| recall@5  |       8 |         0.497  |   0.2645 |            0.2326 | 6/0/2              |    0.01953  |        0.03906  |              0.8333 |              0.09375 |

## Learned vs the σ hybrid alone (E6)

| metric    |   sites |   mean learned |   mean hybrid |   mean difference | wins/ties/losses   |   p (a > b) |   p (two-sided) |   r (rank-biserial) |   p_holm (two-sided) |
|:----------|--------:|---------------:|--------------:|------------------:|:-------------------|------------:|----------------:|--------------------:|---------------------:|
| auc       |       8 |         0.8219 |        0.6161 |            0.2058 | 8/0/0              |    0.003906 |        0.007812 |              1      |              0.03906 |
| mrr       |       8 |         0.4182 |        0.2254 |            0.1929 | 7/0/1              |    0.02734  |        0.05469  |              0.7778 |              0.1562  |
| recall@10 |       8 |         0.5582 |        0.3082 |            0.25   | 7/0/1              |    0.01953  |        0.03906  |              0.8333 |              0.1562  |
| recall@20 |       8 |         0.6346 |        0.3763 |            0.2583 | 7/0/1              |    0.01953  |        0.03906  |              0.8333 |              0.1562  |
| recall@5  |       8 |         0.497  |        0.2675 |            0.2296 | 6/0/2              |    0.02734  |        0.05469  |              0.7778 |              0.1562  |

## E3: total ΔPR of the top-k applied together

|                            |   sites |   mean total ΔPR |   median total ΔPR | wins/ties/losses   |   p (two-sided) |
|:---------------------------|--------:|-----------------:|-------------------:|:-------------------|----------------:|
| (10, 'Learned (LightGBM)') |       9 |        0.009687  |          0.002312  | nan                |       nan       |
| (10, 'S (refGateCosine)')  |       9 |        0.008036  |          0.006298  | nan                |       nan       |
| (10, 'Random')             |       9 |        0.01194   |          0.002107  | nan                |       nan       |
| (10, 'learned − S')        |       9 |        0.001651  |         -0.0003585 | 2/1/6              |         0.3828  |
| (25, 'Learned (LightGBM)') |       9 |        0.01935   |          0.003114  | nan                |       nan       |
| (25, 'S (refGateCosine)')  |       9 |        0.02019   |          0.01666   | nan                |       nan       |
| (25, 'Random')             |       9 |        0.01966   |          0.004932  | nan                |       nan       |
| (25, 'learned − S')        |       9 |       -0.0008447 |         -0.0007222 | 1/1/7              |         0.1953  |
| (50, 'Learned (LightGBM)') |       9 |        0.02478   |          0.00413   | nan                |       nan       |
| (50, 'S (refGateCosine)')  |       9 |        0.0369    |          0.0185    | nan                |       nan       |
| (50, 'Random')             |       9 |        0.02874   |          0.01031   | nan                |       nan       |
| (50, 'learned − S')        |       9 |       -0.01212   |         -0.01476   | 0/2/7              |         0.01562 |

## E8 human ratings

No second label set: fewer than two sites have E8 ratings.

## Global feature importance (mean |SHAP|, held-out E6 sample)

|                   |   mean |SHAP| |     share |
|:------------------|--------------:|----------:|
| ref               |     0.8218    | 0.2185    |
| cosine            |     0.5316    | 0.1414    |
| donor_out         |     0.4854    | 0.1291    |
| donor_type        |     0.2643    | 0.07029   |
| jaccard           |     0.2308    | 0.06137   |
| target_pagerank   |     0.2243    | 0.05964   |
| template_reach    |     0.1476    | 0.03924   |
| target_out        |     0.1247    | 0.03316   |
| target_type       |     0.1241    | 0.033     |
| same_section      |     0.1236    | 0.03286   |
| target_importance |     0.1219    | 0.03243   |
| donor_in          |     0.1217    | 0.03235   |
| donor_pagerank    |     0.1024    | 0.02723   |
| delta_pr          |     0.09274   | 0.02466   |
| target_in         |     0.07997   | 0.02126   |
| kappa             |     0.07257   | 0.0193    |
| donor_importance  |     0.05247   | 0.01395   |
| depth_gain        |     0.02217   | 0.005895  |
| target_depth      |     0.007582  | 0.002016  |
| donor_depth       |     0.006874  | 0.001828  |
| donor_in_scc      |     0.00196   | 0.0005212 |
| newly_reachable   |     0.0001431 | 3.805e-05 |
| target_in_scc     |     6.791e-05 | 1.806e-05 |
| omega_existing    |     0         | 0         |

Figure: shap_summary.pdf, shap_summary.png

## Verdict

- E6: no significant difference between learned and S (MRR +0.216, Holm p = 0.0938, 7/0/1 sites). With 8 sites the smallest two-sided p is 0.00781.
- E3 k = 10: learned − S total ΔPR mean +0.00165, 2/1/6 sites (p = 0.383).
- E3 k = 25: learned − S total ΔPR mean -0.000845, 1/1/7 sites (p = 0.195).
- E3 k = 50: learned − S total ΔPR mean -0.0121, 0/2/7 sites (p = 0.0156).
- S remains the default. E6 labels are a proxy for editorial relevance (an existing link that was hidden); the learned model optimises that proxy, and ω of an existing edge is always 0 in its training rows (E6 candidates never link to the target).
