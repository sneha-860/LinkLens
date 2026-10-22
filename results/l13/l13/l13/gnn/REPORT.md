# GraphSAGE link predictor (E6)

Leave-one-site-out: each site is scored by a GraphSAGE trained on the other sites' masked repeat graphs. E6 metrics are per query (expected under random tie-breaking), averaged over a site's repeats.

## Per site

|                                  |    auc |     mrr |   queries |   recall@10 |   recall@20 |   recall@5 |
|:---------------------------------|-------:|--------:|----------:|------------:|------------:|-----------:|
| ('books-toscrape', 'cosine')     | 0.7721 | 0.08004 |      79.4 |     0.1517  |     0.2106  |    0.1039  |
| ('books-toscrape', 'graphsage')  | 0.9359 | 0.1157  |      79.4 |     0.304   |     0.4939  |    0.1449  |
| ('books-toscrape', 'hybrid')     | 0.5672 | 0.1069  |      79.4 |     0.1524  |     0.17    |    0.1436  |
| ('books-toscrape', 'ref')        | 0.8431 | 0.2391  |      79.4 |     0.6319  |     0.6693  |    0.5646  |
| ('css-tricks', 'cosine')         | 0.6766 | 0.09996 |     556.4 |     0.136   |     0.1914  |    0.1108  |
| ('css-tricks', 'graphsage')      | 0.5603 | 0.08062 |     556.4 |     0.08943 |     0.1051  |    0.08191 |
| ('css-tricks', 'hybrid')         | 0.6252 | 0.1061  |     556.4 |     0.1441  |     0.1913  |    0.1167  |
| ('css-tricks', 'ref')            | 0.7131 | 0.1782  |     556.4 |     0.2627  |     0.3111  |    0.2195  |
| ('flask', 'cosine')              | 0.7835 | 0.2372  |      42.6 |     0.5274  |     0.7483  |    0.3132  |
| ('flask', 'graphsage')           | 0.72   | 0.3385  |      42.6 |     0.5238  |     0.6642  |    0.4014  |
| ('flask', 'hybrid')              | 0.6081 | 0.2333  |      42.6 |     0.3592  |     0.4976  |    0.275   |
| ('flask', 'ref')                 | 0.8106 | 0.2262  |      42.6 |     0.5537  |     0.7534  |    0.4042  |
| ('julia-evans', 'cosine')        | 0.7318 | 0.08543 |     105.6 |     0.1473  |     0.2021  |    0.09476 |
| ('julia-evans', 'graphsage')     | 0.8858 | 0.7506  |     105.6 |     0.7564  |     0.7605  |    0.753   |
| ('julia-evans', 'hybrid')        | 0.5825 | 0.1395  |     105.6 |     0.1994  |     0.2284  |    0.1808  |
| ('julia-evans', 'ref')           | 0.9319 | 0.3606  |     105.6 |     0.7317  |     0.8192  |    0.6082  |
| ('scrapeme-live', 'cosine')      | 0.6761 | 0.09359 |     133.8 |     0.201   |     0.2858  |    0.1261  |
| ('scrapeme-live', 'graphsage')   | 0.6622 | 0.06016 |     133.8 |     0.1257  |     0.2279  |    0.05826 |
| ('scrapeme-live', 'hybrid')      | 0.4227 | 0.03276 |     133.8 |     0.04367 |     0.07733 |    0.02683 |
| ('scrapeme-live', 'ref')         | 0.7676 | 0.3658  |     133.8 |     0.6479  |     0.6728  |    0.5559  |
| ('simon-willison', 'cosine')     | 0.6559 | 0.1968  |    1259   |     0.2416  |     0.2929  |    0.2117  |
| ('simon-willison', 'graphsage')  | 0.6122 | 0.1127  |    1259   |     0.1303  |     0.1859  |    0.0961  |
| ('simon-willison', 'hybrid')     | 0.7036 | 0.2887  |    1259   |     0.4157  |     0.47    |    0.3553  |
| ('simon-willison', 'ref')        | 0.8631 | 0.4578  |    1259   |     0.5658  |     0.628   |    0.5049  |
| ('vite', 'cosine')               | 0.7156 | 0.4445  |      37.2 |     0.6546  |     0.8218  |    0.5463  |
| ('vite', 'graphsage')            | 0.7021 | 0.3718  |      37.2 |     0.6677  |     0.8088  |    0.4877  |
| ('vite', 'hybrid')               | 0.6365 | 0.3987  |      37.2 |     0.5577  |     0.7677  |    0.4527  |
| ('vite', 'ref')                  | 0.8432 | 0.5396  |      37.2 |     0.82    |     0.9419  |    0.7108  |
| ('webscraper-test', 'cosine')    | 0.8518 | 0.4812  |     331   |     0.5825  |     0.6483  |    0.5456  |
| ('webscraper-test', 'graphsage') | 0.6347 | 0.2174  |     331   |     0.2513  |     0.3032  |    0.2193  |
| ('webscraper-test', 'hybrid')    | 0.7291 | 0.4352  |     331   |     0.5358  |     0.5878  |    0.4853  |
| ('webscraper-test', 'ref')       | 0.8952 | 0.5089  |     331   |     0.6478  |     0.7267  |    0.5653  |

## GraphSAGE vs REF, cosine and the hybrid across sites

|                                            |   sites |   mean graphsage |   mean baseline |   mean difference | wins/ties/losses   |   p (two-sided) |   p_holm (over baselines) |   r (rank-biserial) |
|:-------------------------------------------|--------:|-----------------:|----------------:|------------------:|:-------------------|----------------:|--------------------------:|--------------------:|
| ('auc', 'Hybrid (REF-gated cosine)')       |       8 |           0.7141 |          0.6094 |           0.1048  | 5/0/3              |         0.1953  |                   0.3906  |             0.5556  |
| ('mrr', 'Hybrid (REF-gated cosine)')       |       8 |           0.2559 |          0.2177 |           0.03829 | 4/0/4              |         1       |                   1       |             0       |
| ('recall@10', 'Hybrid (REF-gated cosine)') |       8 |           0.3561 |          0.301  |           0.05507 | 5/0/3              |         0.6406  |                   1       |             0.2222  |
| ('auc', 'Cosine')                          |       8 |           0.7141 |          0.7329 |          -0.01878 | 2/0/6              |         0.5469  |                   0.5469  |            -0.2778  |
| ('mrr', 'Cosine')                          |       8 |           0.2559 |          0.2148 |           0.0411  | 3/0/5              |         0.9453  |                   1       |            -0.05556 |
| ('recall@10', 'Cosine')                    |       8 |           0.3561 |          0.3303 |           0.0258  | 3/0/5              |         0.8438  |                   1       |            -0.1111  |
| ('auc', 'REF')                             |       8 |           0.7141 |          0.8335 |          -0.1193  | 1/0/7              |         0.03906 |                   0.1172  |            -0.8333  |
| ('mrr', 'REF')                             |       8 |           0.2559 |          0.3595 |          -0.1036  | 2/0/6              |         0.3125  |                   0.9375  |            -0.4444  |
| ('recall@10', 'REF')                       |       8 |           0.3561 |          0.6077 |          -0.2516  | 1/0/7              |         0.01562 |                   0.04688 |            -0.9444  |

## Runtime (ms; one CPU thread)

|                 |   nodes |   body_edges |   training_graphs |    export_ms |   train_ms |     score_ms |
|:----------------|--------:|-------------:|------------------:|-------------:|-----------:|-------------:|
| css-tricks      |     468 |   4157       |                35 |    2.233e+05 |  1.802e+05 |    1.097e+04 |
| simon-willison  |     485 |      2.4e+04 |                35 |    6.136e+05 |  1.059e+05 | 7536         |
| julia-evans     |     499 |   1825       |                35 |    4.19e+04  |  1.992e+05 |    3.638e+06 |
| books-toscrape  |     500 |   3109       |                35 |    1.428e+04 |  7.34e+04  |  766         |
| scrapeme-live   |     218 |    889       |                35 | 6090         |  1.451e+05 | 3631         |
| webscraper-test |     341 |   2196       |                35 |    8.26e+04  |  2.873e+05 | 4478         |
| vite            |      56 |    247       |                35 | 9444         |  4.19e+05  |  311         |
| flask           |      76 |    284       |                35 |    1.12e+04  |  4.119e+05 |  462         |
| total           |     nan |    nan       |               nan |    1.002e+06 |  1.822e+06 |    3.666e+06 |

## L13 ranker with the graphsage feature vs without (E6)

| metric    |   sites |   mean learned+graphsage |   mean learned |   mean difference | wins/ties/losses   |   p (a > b) |   p (two-sided) |   r (rank-biserial) |   p_holm (two-sided) |
|:----------|--------:|-------------------------:|---------------:|------------------:|:-------------------|------------:|----------------:|--------------------:|---------------------:|
| auc       |       8 |                   0.823  |         0.8219 |          0.001071 | 3/0/5              |      0.4727 |          0.9453 |             0.05556 |                    1 |
| mrr       |       8 |                   0.4168 |         0.4182 |         -0.00147  | 3/0/5              |      0.6797 |          0.7422 |            -0.1667  |                    1 |
| recall@10 |       8 |                   0.5562 |         0.5582 |         -0.002042 | 2/3/3              |      0.6875 |          0.8125 |            -0.2     |                    1 |
| recall@20 |       8 |                   0.6364 |         0.6346 |          0.001772 | 5/0/3              |      0.4219 |          0.8438 |             0.1111  |                    1 |
| recall@5  |       8 |                   0.49   |         0.497  |         -0.006996 | 2/1/5              |      0.8516 |          0.375  |            -0.4286  |                    1 |

## Verdict

- No significant MRR difference between GraphSAGE and Hybrid (REF-gated cosine) (+0.038, Holm p = 1, 4/0/4 sites).
- No significant MRR difference between GraphSAGE and Cosine (+0.041, Holm p = 1, 3/0/5 sites).
- No significant MRR difference between GraphSAGE and REF (-0.104, Holm p = 0.938, 2/0/6 sites).
- L13 ranker + graphsage vs without: MRR -0.001, 3/0/5 sites (p = 0.742).
- The graphsage method and feature stay off by default (config.graphsageEnabled). E6 labels are links the site already had, a proxy for editorial relevance.
