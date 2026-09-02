from __future__ import annotations


def format_fen(value: int | None) -> str:
    """Format integer fen without crossing a floating-point boundary."""
    if value is None:
        return "待确认"
    sign = "-" if value < 0 else ""
    yuan, fen = divmod(abs(value), 100)
    return f"{sign}{yuan}.{fen:02d} 元"
