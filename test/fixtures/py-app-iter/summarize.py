"""Summarizes a stream of order amounts."""


def summarize(amounts):
    total = sum(amounts)
    # Bug: `amounts` may be a one-shot iterator (e.g. a generator). Re-iterating
    # it here silently yields nothing on the second pass, so `count` comes out
    # wrong for exactly the callers who don't pass a list.
    count = sum(1 for _ in amounts)
    return {"total": total, "count": count}
