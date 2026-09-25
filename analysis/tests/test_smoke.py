import linklens_analysis


def test_seed_matches_core_config() -> None:
    assert linklens_analysis.RANDOM_SEED == 42
