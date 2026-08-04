from summarize import summarize


def amounts_generator():
    yield 500
    yield 250
    yield 100


def test_summarize_a_list():
    assert summarize([500, 250, 100]) == {"total": 850, "count": 3}


def test_summarize_a_generator():
    # A generator is a perfectly good iterable; consuming it twice is the
    # seeded bug — count comes out as 0 instead of 3.
    assert summarize(amounts_generator()) == {"total": 850, "count": 3}
