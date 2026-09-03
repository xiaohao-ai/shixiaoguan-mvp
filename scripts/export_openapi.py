"""Export the FastAPI contract without touching persistent state or a live model."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = REPOSITORY_ROOT / "apps" / "api" / "openapi.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="OpenAPI JSON destination (defaults to apps/api/openapi.json).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_path = args.output.resolve()

    # Importing the application constructs its database and attachment store. Keep
    # both ephemeral, and make an accidentally injected CI API key unusable here.
    with TemporaryDirectory(prefix="shixiaoguan-openapi-") as temporary_root:
        os.environ["MODEL_MODE"] = "replay"
        os.environ["DATABASE_URL"] = "sqlite://"
        os.environ["UPLOAD_DIR"] = str(Path(temporary_root) / "uploads")
        os.environ["DEEPSEEK_API_KEY"] = ""
        os.environ["OPENAI_API_KEY"] = ""

        from shixiaoguan_api.main import app

        contract = app.openapi()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(contract, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"Exported deterministic OpenAPI contract to {output_path}")


if __name__ == "__main__":
    main()
